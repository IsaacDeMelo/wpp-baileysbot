require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    jidNormalizedUser,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const moment = require('moment');
const cloudinary = require('cloudinary').v2;
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { createCanvas, loadImage } = require('canvas');

// ===================================
// ⚙️ CONFIGURAÇÕES & ENV
// ===================================
const PORT = process.env.SERVER_PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ALLOW_HTTP_ACTION = (process.env.ALLOW_HTTP_ACTION || '').toLowerCase() === 'true';
const ALLOW_RESERVED_OVERRIDE = (process.env.ALLOW_RESERVED_OVERRIDE || '').toLowerCase() === 'true';
const HEAR_SELF_COMMANDS = (process.env.HEAR_SELF_COMMANDS || '').toLowerCase() === 'true';
const HEAR_SELF_ALLOWED_JIDS = new Set(
    String(process.env.HEAR_SELF_ALLOWED_JIDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);
const SECURITY_AUDIT_INTERVAL_MS = Math.max(60_000, Number(process.env.SECURITY_AUDIT_INTERVAL_MS || 3_600_000));

// ===================================
// 🧯 BAILEYS: RATE LIMIT GUARDS (429)
// ===================================
// Previne rate limits e chamadas repetidas.
const BAILEYS_SEND_MIN_INTERVAL_MS = Math.max(0, Number(process.env.BAILEYS_SEND_MIN_INTERVAL_MS || 900));
const BAILEYS_RETRY_MAX = Math.max(0, Number(process.env.BAILEYS_RETRY_MAX || 3));
const BAILEYS_RETRY_BASE_MS = Math.max(200, Number(process.env.BAILEYS_RETRY_BASE_MS || 4000));
const BAILEYS_GROUPMETA_TTL_MS = Math.max(5_000, Number(process.env.BAILEYS_GROUPMETA_TTL_MS || 5 * 60_000));
const BAILEYS_DROP_ON_RATE_LIMIT = (process.env.BAILEYS_DROP_ON_RATE_LIMIT || 'true').toLowerCase() === 'true';

const __groupMetaCache = new Map(); // jid -> { ts, value }
const __groupMetaInFlight = new Map(); // jid -> Promise
const __lastSendAtByJid = new Map(); // jid -> ts
let __lastSendAtGlobal = 0;
let __sendQueue = Promise.resolve();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('rate-overlimit') || msg.includes('overlimit')) return true;
    if (err?.data === 429) return true;
    const code = err?.output?.payload?.statusCode;
    if (code === 429) return true;
    return false;
}

async function withBackoffRetry(fn, { maxRetries = BAILEYS_RETRY_MAX, baseMs = BAILEYS_RETRY_BASE_MS } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (!isRateLimitError(err) || attempt >= maxRetries) break;
            const jitter = Math.floor(Math.random() * 300);
            const waitMs = baseMs * Math.pow(2, attempt) + jitter;
            await sleep(waitMs);
        }
    }
    throw lastErr;
}

function installBaileysGuards(sock) {
    if (!sock || sock.__rateLimitGuardsInstalled) return;
    sock.__rateLimitGuardsInstalled = true;

    // --- groupMetadata cache + retry + stale fallback ---
    if (typeof sock.groupMetadata === 'function') {
        const origGroupMetadata = sock.groupMetadata.bind(sock);

        sock.groupMetadata = async (jid, ...rest) => {
            const key = String(jid || '');
            const now = Date.now();
            const cached = __groupMetaCache.get(key);

            if (cached && (now - cached.ts) <= BAILEYS_GROUPMETA_TTL_MS) {
                return cached.value;
            }

            const inFlight = __groupMetaInFlight.get(key);
            if (inFlight) return await inFlight;

            const p = (async () => {
                try {
                    const value = await withBackoffRetry(() => origGroupMetadata(key, ...rest));
                    __groupMetaCache.set(key, { ts: Date.now(), value });
                    return value;
                } catch (err) {
                    // Se rate limit e já temos cache (mesmo expirado), devolve o cache para não travar envios.
                    if (isRateLimitError(err) && cached?.value) {
                        return cached.value;
                    }
                    throw err;
                } finally {
                    __groupMetaInFlight.delete(key);
                }
            })();

            __groupMetaInFlight.set(key, p);
            return await p;
        };
    }

    // --- sendMessage throttle + retry + optional drop-on-rate-limit ---
    if (typeof sock.sendMessage === 'function') {
        const origSendMessage = sock.sendMessage.bind(sock);

        const throttledSend = async (jid, ...args) => {
            const key = String(jid || '');
            const now = Date.now();
            const lastJid = __lastSendAtByJid.get(key) || 0;
            const waitGlobal = Math.max(0, BAILEYS_SEND_MIN_INTERVAL_MS - (now - __lastSendAtGlobal));
            const waitJid = Math.max(0, BAILEYS_SEND_MIN_INTERVAL_MS - (now - lastJid));
            const waitMs = Math.max(waitGlobal, waitJid);
            if (waitMs > 0) await sleep(waitMs + Math.floor(Math.random() * 120));

            return await withBackoffRetry(() => origSendMessage(key, ...args));
        };

        sock.sendMessage = (jid, ...args) => {
            __sendQueue = __sendQueue.then(async () => {
                try {
                    const res = await throttledSend(jid, ...args);
                    const t = Date.now();
                    __lastSendAtGlobal = t;
                    __lastSendAtByJid.set(String(jid || ''), t);
                    return res;
                } catch (err) {
                    if (BAILEYS_DROP_ON_RATE_LIMIT && isRateLimitError(err)) {
                        console.warn(`⚠️ rate-overlimit (429): mensagem descartada para ${jid}`);
                        return null;
                    }
                    throw err;
                }
            });
            return __sendQueue;
        };
    }
}

// IDs Fixos (Preencha com os JIDs reais dos grupos de administração)
const ID_GRU.
const ID_GRUPO_DENUNCIAS = "1203630000000001@g.us";
const MY_PHONE_NUMBER = "5582988516706";

// Configuração Cloudinary.
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

moment.locale('pt-br');

// ===================================
// 🗄️ SCHEMAS MONGODB
// ===================================

const UserProfileSchema = new mongoose.Schema({
    jid: { type: String, unique: true },
    name: String,
    realName: String,
    phoneNumber: String,
    rank: { type: String, enum: ['Membro', 'Master', 'Coord', 'Dev'], default: 'Membro' },
    bio: { type: String, default: "Sem biografia definida." },
    cargos: { type: [String], default: [] },
    isCanonized: { type: Boolean, default: false }, //
    backgroundUrl: { type: String, default: null }, // 
    // Groups History
    activeGroups: [{
        jid: String, groupName: String, role: String, joinedAt: { type: Date, default: Date.now },
        msgCount: { type: Number, default: 0 }, lastActive: { type: Date, default: Date.now }
    }],
    inactiveGroups: [{ jid: String, groupName: String, role: String, period: String, finalMsgCount: Number }],

    // Warnings & Bans
    globalWarnings: [{
        id: String, reason: String, date: { type: Date, default: Date.now },
        admin: String, duration: String, endDate: Date
    }],
    localWarnings: [{
        id: String, groupJid: String, groupName: String, reason: String,
        date: { type: Date, default: Date.now }, admin: String
    }],

    isMailRegistered: { type: Boolean, default: false },
    mailLists: [{
        name: { type: String, lowercase: true },
        targets: [String] // Pode conter JIDs de pessoas ou Nicks de grupos
    }],

    // Embargo (Global Ban)
    embargo: {
        active: { type: Boolean, default: false },
        reason: String,
        link: String,
        since: Date,
        duration: String,
        endDate: Date,
        admin: String
    },

    nameHistory: [{ name: String, date: { type: Date, default: Date.now } }],
    observations: [{ text: String, date: { type: Date, default: Date.now }, author: String }]
});

const CommunitySchema = new mongoose.Schema({
    name: { type: String, unique: true },
    description: String,
    creatorJid: String,
    imageUrl: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    groups: [String], // Array de JIDs (@g.us)
    // Histórico de mensagens.
    activityLog: [{
        date: { type: String }, // Formato YYYY-MM-DD
        count: { type: Number, default: 0 }
    }]
});
const Community = mongoose.model('Community', CommunitySchema);

const CommandDocSchema = new mongoose.Schema({
    trigger: { type: String, unique: true }, // Ex: !adv
    category: String,                        // Ex: ⚖️ MODERAÇÃO
    description: String,                     // Ex: Adverte um usuário
    rankRequired: { type: String, enum: ['Membro', 'Master', 'Dev'], default: 'Membro' }
});

const CommandDoc = mongoose.model('CommandDoc', CommandDocSchema);

// ===================================
// 🧩 COMANDOS DINÂMICOS (NO-CODE)
// ===================================

const DynamicCommandSchema = new mongoose.Schema({
    trigger: { type: String, unique: true, lowercase: true, trim: true }, // Ex: !bomdia
    name: { type: String, default: '' },
    category: { type: String, default: '🧩 DINÂMICO' },
    description: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    overrideReserved: { type: Boolean, default: false },
    rankRequired: { type: String, enum: ['Membro', 'Master', 'Coord', 'Dev'], default: 'Membro' },
    allowedGroups: { type: [String], default: [] }, // vazio = todos
    cooldownMs: { type: Number, default: 0 },
    actions: {
        type: [
            {
                type: { type: String, required: true },
                config: { type: Object, default: {} }
            }
        ],
        default: []
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

DynamicCommandSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

const CommandRunLogSchema = new mongoose.Schema({
    trigger: { type: String, index: true },
    commandId: { type: mongoose.Schema.Types.ObjectId, index: true },
    at: { type: Date, default: Date.now },
    jid: String,
    isGroup: Boolean,
    sender: String,
    senderName: String,
    ok: { type: Boolean, default: true },
    outputs: { type: [Object], default: [] },
    error: { type: String, default: null }
});

const DynamicCommand = mongoose.model('DynamicCommand', DynamicCommandSchema);
const CommandRunLog = mongoose.model('CommandRunLog', CommandRunLogSchema);

const GroupConfigSchema = new mongoose.Schema({
    jid: { type: String, unique: true },
    nick: { type: String, lowercase: true },
    description: String,
    mailRegistered: { type: Boolean, default: false },
    communityName: { type: String, default: null },
    botActive: { type: Boolean, default: true },

    // --- Configurações Anti-Spam ---
    antispam: {
        enabled: { type: Boolean, default: false },
        maxMsgs: { type: Number, default: 5 },     // Msgs permitidas
        windowMs: { type: Number, default: 5000 }, // No intervalo de (ex: 5s)
        antiRepeat: { type: Boolean, default: true },
        punishment: { type: String, default: 'local' } // local, global, ban
    },

    // --- Configurações Anti-Figurinha ---
    antisticker: {
        enabled: { type: Boolean, default: false },
        limit: { type: Number, default: 3 },
        windowMs: { type: Number, default: 10000 }, // ex: 3 figs em 10s
        punishment: { type: String, default: 'local' }
    },

    autoBanList: [{ jid: String, reason: String, link: String, admin: String, date: { type: Date, default: Date.now } }]
});

const SystemConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'global', index: true },
    systemInstruction: { type: String, default: '' },
    allowedGroups: { type: [String], default: [] },
    botActive: { type: Boolean, default: true }
}, { timestamps: true });

const UserProfile = mongoose.model('UserProfile', UserProfileSchema);
const GroupConfig = mongoose.model('GroupConfig', GroupConfigSchema);
const SystemConfig = mongoose.model('SystemConfig', SystemConfigSchema);

// ===================================
// 🛠️ FUNÇÕES AUXILIARES
// ===================================

function cleanID(jid) {
    if (!jid) return "";
    return jid.split('@')[0].split(':')[0];
}

function normalizeUserJid(jid) {
    try {
        return jidNormalizedUser(jid);
    } catch (e) {
        return jid;
    }
}

function phoneVariantsFromJid(jid) {
    const num = cleanID(jid || '').replace(/\D/g, '');
    if (!num) return [];

    let v1 = num;
    let v2 = num;
    // Brasil: 55 + DDD + 8/9 dígitos
    if (num.length === 12) {
        v2 = num.slice(0, 4) + '9' + num.slice(4);
    } else if (num.length === 13) {
        v2 = num.slice(0, 4) + num.slice(5);
    }
    return Array.from(new Set([v1, v2]));
}

function matchUserByJidOrPhone(candidateJid, storedJid) {
    if (!candidateJid || !storedJid) return false;
    const a = normalizeUserJid(candidateJid);
    const b = normalizeUserJid(storedJid);
    if (a === b) return true;
    const an = cleanID(a).replace(/\D/g, '');
    const bn = cleanID(b).replace(/\D/g, '');
    if (an && bn && an === bn) return true;
    return false;
}

async function findExistingUserByJidOrPhone(jid) {
    const cleanJid = normalizeUserJid(jid);
    const variants = phoneVariantsFromJid(cleanJid);

    let user = await UserProfile.findOne({ jid: cleanJid });
    if (user) return user;
    if (variants.length) {
        user = await UserProfile.findOne({ phoneNumber: { $in: variants } });
        if (user) return user;
    }
    return null;
}

function getNextId(array, prefix) {
    return `${prefix}${array.length + 1}`;
}

function parseDuration(durationStr) {
    // Ex: "60d" -> Date object
    if (!durationStr) return null;
    const num = parseInt(durationStr);
    const unit = durationStr.replace(/\d/g, '').toLowerCase();
    if (isNaN(num)) return null;
    return moment().add(num, unit === 'm' ? 'minutes' : 'days').toDate();
}

function normalizeTrigger(trigger) {
    if (!trigger) return '';
    const t = String(trigger).trim().toLowerCase();
    if (!t) return '';
    return t.startsWith('!') ? t : `!${t}`;
}

function getRankLevel(rank) {
    switch ((rank || 'Membro')) {
        case 'Dev': return 4;
        case 'Coord': return 3;
        case 'Master': return 2;
        default: return 1;
    }
}

function renderTemplate(template, ctx) {
    if (template === null || template === undefined) return '';
    const str = String(template);
    return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawPath) => {
        const pathStr = String(rawPath || '').trim();
        if (!pathStr) return '';

        const parts = pathStr.split('.').map(p => p.trim()).filter(Boolean);
        let cur = ctx;
        for (const part of parts) {
            if (cur === null || cur === undefined) return '';
            if (Array.isArray(cur)) {
                const idx = Number(part);
                cur = Number.isFinite(idx) ? cur[idx] : undefined;
            } else {
                cur = cur[part];
            }
        }
        if (cur === null || cur === undefined) return '';
        return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : '';
    });
}

async function fetchBufferFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao baixar: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
}

async function readLimitedText(res, limitBytes = 200_000) {
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > limitBytes) throw new Error('Resposta muito grande');

    const reader = res.body?.getReader?.();
    if (!reader) {
        const txt = await res.text();
        if (Buffer.byteLength(txt, 'utf8') > limitBytes) throw new Error('Resposta muito grande');
        return txt;
    }

    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limitBytes) throw new Error('Resposta muito grande');
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function showTypingPresence(jid, ms = 800) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await delay(Math.min(3000, Math.max(200, Number(ms) || 800)));
    } catch (e) { }
    try {
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) { }
}

function coercePrimitive(value) {
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (s.toLowerCase() === 'true') return true;
    if (s.toLowerCase() === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
}

function evaluateCondition(cfg, ctx) {
    const leftRaw = renderTemplate(cfg.left ?? '', ctx);
    const rightRaw = renderTemplate(cfg.right ?? '', ctx);
    const op = String(cfg.op || '==').trim();
    const caseInsensitive = String(cfg.caseInsensitive || '').toLowerCase() === 'true' || cfg.caseInsensitive === true;

    const left = coercePrimitive(leftRaw);
    const right = coercePrimitive(rightRaw);
    const asStr = (v) => caseInsensitive ? String(v ?? '').toLowerCase() : String(v ?? '');

    if (op === 'exists') return String(leftRaw ?? '').trim().length > 0;
    if (op === 'notExists') return String(leftRaw ?? '').trim().length === 0;

    if (op === '==') return left === right;
    if (op === '!=') return left !== right;

    if (op === '>' || op === '>=' || op === '<' || op === '<=') {
        const ln = Number(left);
        const rn = Number(right);
        if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
        if (op === '>') return ln > rn;
        if (op === '>=') return ln >= rn;
        if (op === '<') return ln < rn;
        if (op === '<=') return ln <= rn;
    }

    if (op === 'contains') return asStr(left).includes(asStr(right));
    if (op === 'startsWith') return asStr(left).startsWith(asStr(right));
    if (op === 'endsWith') return asStr(left).endsWith(asStr(right));

    if (op === 'regex') {
        const pat = String(rightRaw ?? '');
        if (!pat) return false;
        try {
            const m = pat.match(/^\/(.*)\/(i|g|m|s|u|y)*$/);
            const re = m ? new RegExp(m[1], m[2] || '') : new RegExp(pat, caseInsensitive ? 'i' : '');
            return re.test(String(leftRaw ?? ''));
        } catch (e) {
            return false;
        }
    }

    return false;
}

const RESERVED_COMMANDS = new Set([
    '!bot', '!kick', '!adv', '!menu', '!help', '!rmadv', '!listadv', '!listaadv', '!embargo',
    '!autoban', '!cadastrarmail', '!cadastrargp', '!listgp', '!criarlistmail', '!addmail', '!mail',
    '!listmailusers', '!listusuariosmail', '!userg', '!globalusers', '!filtrog', '!sticker', '!ping',
    '!dev', '!master', '!canonizar', '!linkimg', '!addcargo', '!rmcargo', '!rgperfil', '!bio',
    '!background', '!capa', '!comunidade', '!comunidades', '!antispam', '!antisticker', '!comandos',
    '!guia', '!helpall'
]);

const commandCooldowns = new Map(); // key = `${jid}:${sender}:${trigger}` -> lastRunMs
const selfCommandSeen = new Map(); // msgId -> ts (anti-loop)

async function executeDynamicCommand({ sock, msg, jid, isGroup, user, groupName, isAdmin, isSuperAdmin, isOwner, isDev, isMaster, cleanSender, content, args, argText, commandDef }) {
    const runtimeVars = {};
    const ctx = {
        command: commandDef.trigger,
        args,
        argText,
        group: {
            jid,
            name: groupName,
            isGroup
        },
        sender: {
            jid: cleanSender,
            name: user?.name || msg.pushName || 'Desconhecido',
            phone: user?.phoneNumber || cleanID(cleanSender),
            rank: user?.rank || 'Membro',
            isAdmin,
            isSuperAdmin,
            isOwner,
            isDev,
            isMaster
        },
        user,
        vars: runtimeVars
    };

    const outputs = [];

    const runActions = async (actions, depth = 0) => {
        if (!Array.isArray(actions)) return;
        if (depth > 6) throw new Error('Fluxo muito profundo (if aninhado demais)');

        for (const action of actions) {
            const type = action?.type;
            const cfg = action?.config || {};

            if (type === 'sendText') {
                const text = renderTemplate(cfg.text || '', ctx);
                if (!text) continue;
                await sock.sendMessage(jid, { text });
                outputs.push({ type: 'text', preview: text.slice(0, 500) });
            }

            if (type === 'sendReaction') {
                const emoji = renderTemplate(cfg.emoji || '', ctx).trim();
                if (!emoji) continue;
                await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
                outputs.push({ type: 'reaction', preview: emoji });
            }

            if (type === 'delay') {
                const ms = Number(cfg.ms || 0);
                if (Number.isFinite(ms) && ms > 0) await delay(ms);
                outputs.push({ type: 'delay', preview: String(ms) });
            }

            if (type === 'sendImageUrl') {
                const url = renderTemplate(cfg.url || '', ctx).trim();
                if (!url) continue;
                const caption = renderTemplate(cfg.caption || '', ctx);
                await sock.sendMessage(jid, { image: { url }, caption: caption || undefined });
                outputs.push({ type: 'image', preview: url });
            }

            if (type === 'sendStickerUrl') {
                const url = renderTemplate(cfg.url || '', ctx).trim();
                if (!url) continue;
                const pack = renderTemplate(cfg.pack || 'Academy', ctx);
                const author = renderTemplate(cfg.author || 'Academy System', ctx);
                const buf = await fetchBufferFromUrl(url);
                const sticker = new Sticker(buf, {
                    pack,
                    author,
                    type: StickerTypes.FULL,
                    quality: 70
                });
                const stickerBuf = await sticker.toBuffer();
                await sock.sendMessage(jid, { sticker: stickerBuf });
                outputs.push({ type: 'sticker', preview: url });
            }

            if (type === 'setVar') {
                const name = renderTemplate(cfg.name || '', ctx).trim();
                if (!name) continue;
                const value = renderTemplate(cfg.value || '', ctx);
                runtimeVars[name] = value;
                outputs.push({ type: 'var', preview: `${name}=${String(value).slice(0, 200)}` });
            }

            if (type === 'httpRequest') {
                if (!ALLOW_HTTP_ACTION) throw new Error('Ação httpRequest desabilitada. Defina ALLOW_HTTP_ACTION=true');
                const storeAs = renderTemplate(cfg.storeAs || 'http', ctx).trim() || 'http';
                const method = String(cfg.method || 'GET').toUpperCase();
                const url = renderTemplate(cfg.url || '', ctx).trim();
                if (!url) continue;

                let headers = {};
                if (cfg.headersJson) {
                    try {
                        const parsed = JSON.parse(renderTemplate(cfg.headersJson || '', ctx) || '{}');
                        if (parsed && typeof parsed === 'object') headers = parsed;
                    } catch (e) { }
                }

                const timeoutMs = Math.min(30_000, Math.max(500, Number(cfg.timeoutMs || 10_000) || 10_000));
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const body = cfg.body ? renderTemplate(cfg.body || '', ctx) : undefined;
                    const res = await fetch(url, {
                        method,
                        headers,
                        body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
                        signal: controller.signal
                    });
                    const text = await readLimitedText(res, 200_000);
                    let json = null;
                    const wantJson = (String(cfg.parseJson || '')).toLowerCase() === 'true' || (res.headers.get('content-type') || '').includes('application/json');
                    if (wantJson) {
                        try { json = JSON.parse(text); } catch (e) { json = null; }
                    }
                    runtimeVars[storeAs] = { ok: res.ok, status: res.status, text, json };
                    outputs.push({ type: 'http', preview: `${method} ${url} -> ${res.status}` });
                } finally {
                    clearTimeout(t);
                }
            }

            if (type === 'validate') {
                const ok = evaluateCondition(cfg, ctx);
                if (ok) {
                    outputs.push({ type: 'validate', preview: 'ok' });
                    continue;
                }

                const failText = renderTemplate(cfg.failText || '⚠️ Validação falhou.', ctx);
                if (failText) await sock.sendMessage(jid, { text: failText });
                outputs.push({ type: 'validate', preview: 'fail' });
                const stop = cfg.stop === undefined ? true : (String(cfg.stop).toLowerCase() === 'true' || cfg.stop === true);
                if (stop) return { stop: true };
            }

            if (type === 'if') {
                const ok = evaluateCondition(cfg, ctx);
                outputs.push({ type: 'if', preview: ok ? 'true' : 'false' });

                const thenActions = Array.isArray(cfg.thenActions) ? cfg.thenActions : null;
                const elseActions = Array.isArray(cfg.elseActions) ? cfg.elseActions : null;

                if (ok) {
                    if (thenActions) {
                        const r = await runActions(thenActions, depth + 1);
                        if (r?.stop) return r;
                    } else {
                        const thenText = renderTemplate(cfg.thenText || '', ctx);
                        if (thenText) {
                            await sock.sendMessage(jid, { text: thenText });
                            outputs.push({ type: 'text', preview: thenText.slice(0, 500) });
                        }
                    }
                } else {
                    if (elseActions) {
                        const r = await runActions(elseActions, depth + 1);
                        if (r?.stop) return r;
                    } else {
                        const elseText = renderTemplate(cfg.elseText || '', ctx);
                        if (elseText) {
                            await sock.sendMessage(jid, { text: elseText });
                            outputs.push({ type: 'text', preview: elseText.slice(0, 500) });
                        }
                    }
                }
            }

            if (type === 'setUserBio') {
                const bio = renderTemplate(cfg.bio || '', ctx).trim();
                if (!bio) continue;
                user.bio = bio;
                await user.save();
                outputs.push({ type: 'db', preview: 'bio atualizado' });
            }

            if (type === 'addUserCargo') {
                const cargo = renderTemplate(cfg.cargo || '', ctx).trim();
                if (!cargo) continue;
                user.cargos = Array.isArray(user.cargos) ? user.cargos : [];
                if (!user.cargos.includes(cargo)) user.cargos.push(cargo);
                await user.save();
                outputs.push({ type: 'db', preview: `cargo + ${cargo}` });
            }

            if (type === 'removeUserCargo') {
                const cargo = renderTemplate(cfg.cargo || '', ctx).trim();
                if (!cargo) continue;
                user.cargos = Array.isArray(user.cargos) ? user.cargos : [];
                user.cargos = user.cargos.filter(c => c !== cargo);
                await user.save();
                outputs.push({ type: 'db', preview: `cargo - ${cargo}` });
            }
        }
    };

    await runActions(commandDef.actions || [], 0);
    return outputs;
}

async function updateCommunityActivity(communityName, count = 1) {
    const today = moment().format('YYYY-MM-DD');
    await Community.findOneAndUpdate(
        { name: communityName, "activityLog.date": today },
        { $inc: { "activityLog.$.count": count } },
        { new: true }
    ).then(async (res) => {
        if (!res) {
            await Community.findOneAndUpdate(
                { name: communityName },
                { $push: { activityLog: { date: today, count: count } } }
            );
        }
    });
}

function getCommunityStats(community) {
    const now = moment();
    const currentWeek = community.activityLog.filter(log => moment(log.date).isAfter(now.clone().subtract(7, 'days'))).reduce((a, b) => a + b.count, 0);
    const lastWeek = community.activityLog.filter(log => moment(log.date).isBetween(now.clone().subtract(14, 'days'), now.clone().subtract(7, 'days'))).reduce((a, b) => a + b.count, 0);
    return { currentWeek, lastWeek };
}

async function getUser(jid, name) {
    try {
        const cleanJid = jidNormalizedUser(jid); // ID que chegou agora
        const userNum = cleanID(cleanJid);       // Apenas números (ex: 558288...)

        // 1. Tenta buscar pelo JID exato
        let user = await UserProfile.findOne({ jid: cleanJid });

        // 2. Se não achou, tenta buscar pelo número de telefone (pode estar salvo com/sem 9)
        if (!user) {
            // Cria variantes (com e sem o 9 após o DDD 55+XX)
            // Ex: Se veio 558288... busca também 5582988...
            let variant1 = userNum;
            let variant2 = userNum;

            if (userNum.length === 12) { // Sem 9 (55 82 8888-8888)
                variant2 = userNum.slice(0, 4) + '9' + userNum.slice(4);
            } else if (userNum.length === 13) { // Com 9 (55 82 98888-8888)
                variant2 = userNum.slice(0, 4) + userNum.slice(5);
            }

            // Busca no banco por qualquer uma das versões
            user = await UserProfile.findOne({
                phoneNumber: { $in: [variant1, variant2] }
            });

            // Se achou um usuário com ID diferente (ex: trocou de com 9 para sem 9), atualiza o JID
            if (user) {
                console.log(`[DB] Usuário encontrado por telefone! Atualizando JID de ${user.jid} para ${cleanJid}`);
                user.jid = cleanJid;
                user.phoneNumber = userNum; // Atualiza para o formato atual
                await user.save();
            }
        }

        // 3. Se REALMENTE não achou, cria um novo
        if (!user) {
            console.log(`[DB] Usuário Novo Criado: ${cleanJid}`);

            // Verifica se é o DONO (Hardcoded no código para garantir o Dev na criação)
            const myNumRaw = MY_PHONE_NUMBER.replace(/\D/g, '');

            // Verifica flexível (se o número do config está contido no usuário ou vice-versa)
            const isDev = userNum.includes(myNumRaw) || myNumRaw.includes(userNum);

            user = await UserProfile.create({
                jid: cleanJid,
                name: name || "Desconhecido",
                phoneNumber: userNum,
                rank: isDev ? 'Dev' : 'Membro'
            });
        }

        // Garante que o nome seja atualizado se mudou
        if (name && user.name === "Desconhecido") {
            user.name = name;
            await user.save();
        }

        return user;
    } catch (e) {
        console.error("❌ Erro no getUser:", e);
        return { name: "Erro", rank: 'Membro', activeGroups: [], globalWarnings: [], localWarnings: [], embargo: {} };
    }
}

// Verifica e Atualiza dados do grupo no perfil do usuário
async function trackGroupActivity(user, groupJid, groupName, role) {
    if (!groupJid.endsWith('@g.us')) return;

    const idx = user.activeGroups.findIndex(g => g.jid === groupJid);
    const currentRole = role || 'Membro';

    if (idx >= 0) {
        user.activeGroups[idx].msgCount += 1;
        user.activeGroups[idx].lastActive = new Date();
        user.activeGroups[idx].groupName = groupName; // Atualiza nome se mudou
        user.activeGroups[idx].role = currentRole;    // Atualiza cargo (Admin/Membro)
    } else {
        user.activeGroups.push({
            jid: groupJid,
            groupName: groupName,
            role: currentRole,
            msgCount: 1,
            joinedAt: new Date()
        });
    }
    await user.save();
}

async function downloadMedia(msg) {
    try {
        const type = Object.keys(msg.message)[0];
        let mediaMsg = msg.message[type];
        // Suporte a quoted
        if (type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo.quotedMessage) {
            const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const qType = Object.keys(quoted)[0];
            if (qType === 'imageMessage' || qType === 'videoMessage' || qType === 'stickerMessage') {
                mediaMsg = quoted[qType];
                const stream = await downloadContentFromMessage(mediaMsg, qType.replace('Message', ''));
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                return { buffer, type: qType.replace('Message', '') };
            }
        }
        if (!mediaMsg || (!mediaMsg.url && !mediaMsg.directPath)) return null;

        const stream = await downloadContentFromMessage(mediaMsg, type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return { buffer, type: type.replace('Message', '') };
    } catch (e) { return null; }
}

// ===================================
// 🚀 SERVIDOR
// ===================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================================
// 🔐 AUTH ADMIN
// ===================================
const adminTokens = new Map(); // token -> { exp }
const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function issueAdminToken() {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.set(token, { exp: Date.now() + ADMIN_TOKEN_TTL_MS });
    return token;
}

function requireAdmin(req, res, next) {
    const headerToken = req.headers['x-admin-token'];
    const bearer = req.headers.authorization;
    const token = (headerToken || (bearer && bearer.startsWith('Bearer ') ? bearer.slice(7) : '') || '').toString();
    if (!token) return res.status(401).json({ success: false, message: 'Não autenticado' });

    const entry = adminTokens.get(token);
    if (!entry) return res.status(401).json({ success: false, message: 'Token inválido' });
    if (Date.now() > entry.exp) {
        adminTokens.delete(token);
        return res.status(401).json({ success: false, message: 'Token expirado' });
    }
    return next();
}

// --- 1. MIDDLEWARES OBRIGATÓRIOS 
app.use(express.json()); // Essencial para ler o JSON enviado pelo front
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Bloqueia acesso direto a arquivos sensíveis caso use express.static(__dirname)
app.use((req, res, next) => {
    const p = req.path || '';
    if (p.startsWith('/auth_info_baileys') || p.startsWith('/.env') || p === '/update.js' || p === '/index.js') {
        return res.status(404).send('Not Found');
    }
    next();
});

app.use(express.static(__dirname, { dotfiles: 'deny' }));

// --- 2. ROTAS DA API

// Login Administrativo
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    // Verifica a senha.
    if (password === ADMIN_PASSWORD) {
        const token = issueAdminToken();
        return res.json({ success: true, token });
    }
    res.status(401).json({ success: false, message: "Senha incorreta" });
});

// 2. Buscar Config.
app.get('/api/ai-config', requireAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');

        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                success: false,
                message: 'MongoDB não conectado. Verifique MONGO_URI e logs do servidor.'
            });
        }

        // Sempre trabalha com o documento GLOBAL
        let config = await SystemConfig.findOne({ key: 'global' }).lean();
        if (!config) {
            // Se existir algum doc antigo sem key, migra o mais recente
            const legacy = await SystemConfig.findOne({ key: { $ne: 'global' } }).sort({ _id: -1 });
            if (legacy) {
                legacy.key = 'global';
                await legacy.save();
                config = legacy.toObject();
            } else {
                const created = await SystemConfig.create({ key: 'global', systemInstruction: '', allowedGroups: [], botActive: true });
                config = created.toObject();
            }
        }

        res.json({
            systemInstruction: String(config.systemInstruction || ''),
            allowedGroups: Array.isArray(config.allowedGroups) ? config.allowedGroups : [],
            botActive: config.botActive !== false
        });
    } catch (e) {
        res.status(500).json({ error: "Erro interno" });
    }
});

// 3. Salvar Configuração (IA + Whitelist)
app.post('/api/ai-c.sync (req, res) => {
    try {
        const { systemInstruction, allowedGroups } = req.body;

        res.set('Cache-Control', 'no-store');

        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                success: false,
                error: 'MongoDB não conectado. Verifique MONGO_URI e logs do servidor.'
            });
        }

        const sanitizedAllowed = Array.isArray(allowedGroups)
            ? allowedGroups.map(s => String(s || '').trim()).filter(Boolean)
            : [];
        const sanitizedInstruction = String(systemInstruction || '');

        // Atualiza ou Cria a configuração
        const updated = await SystemConfig.findOneAndUpdate(
            { key: 'global' },
            {
                $set: {
                    key: 'global',
                    systemInstruction: sanitizedInstruction,
                    allowedGroups: sanitizedAllowed
                }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
                // mantém consistente mesmo em legacy
                sort: { _id: -1 }
            }
        ).lean();

        console.log("✅ Configuração de IA/Whitelist atualizada via Painel");
        res.json({
            success: true,
            config: {
                systemInstruction: String(updated?.systemInstruction || ''),
                allowedGroups: Array.isArray(updated?.allowedGroups) ? updated.allowedGroups : [],
                botActive: updated?.botActive !== false
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Erro ao salvar" });
    }
});

// ==========================================================
// 🧩 API - COMANDOS DINÂMICOS (NO-COD
// 🧩 API - COMANDOS DINÂMICOS
// 
app.get('/api/dynamic-commands/variables', requireAdmin, (req, res) => {
    const vars = [
        { key: 'sender.name', label: 'Nome do usuário', emoji: '👤', example: 'Isaac' },
        { key: 'sender.rank', label: 'Patente', emoji: '🎖️', example: 'Master' },
        { key: 'sender.phone', label: 'Telefone', emoji: '📞', example: '5582...' },
        { key: 'group.name', label: 'Nome do grupo', emoji: '👥', example: 'Academy' },
        { key: 'group.jid', label: 'ID do grupo', emoji: '🆔', example: '1203...@g.us' },
        { key: 'argText', label: 'Texto após o comando', emoji: '📝', example: 'qualquer coisa' },
        { key: 'args.0', label: 'Argumento 1', emoji: '1️⃣', example: 'foo' },
        { key: 'args.1', label: 'Argumento 2', emoji: '2️⃣', example: 'bar' },
        { key: 'vars.http.ok', label: 'Webhook OK (true/false)', emoji: '✅', example: 'true' },
        { key: 'vars.http.status', label: 'Status do Webhook', emoji: '🌐', example: '200' },
        { key: 'vars.http.text', label: 'Texto do Webhook', emoji: '📦', example: 'ok' },
        { key: 'vars.http.json', label: 'JSON do Webhook (se parseado)', emoji: '🧠', example: '{"ok":true}' }
    ];
    res.json({ success: true, vars });
});

app.get('/api/dynamic-commands', requireAdmin, async (req, res) => {
    const list = await DynamicCommand.find().sort({ updatedAt: -1 });
    res.json({ success: true, list });
});

app.post('/api/dynamic-commands', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const trigger = normalizeTrigger(body.trigger);
        if (!trigger) return res.status(400).json({ success: false, message: 'Trigger inválido' });
        if (RESERVED_COMMANDS.has(trigger)) {
            const wantsOverride = body.overrideReserved === true || String(body.overrideReserved || '').toLowerCase() === 'true';
            if (!(ALLOW_RESERVED_OVERRIDE && wantsOverride)) {
                return res.status(400).json({ success: false, message: 'Esse comando é reservado do sistema.' });
            }
        }

        const overrideReserved = body.overrideReserved === true || String(body.overrideReserved || '').toLowerCase() === 'true';

        const created = await DynamicCommand.create({
            trigger,
            name: body.name || '',
            category: body.category || '🧩 DINÂMICO',
            description: body.description || '',
            enabled: body.enabled !== false,
            overrideReserved,
            rankRequired: body.rankRequired || 'Membro',
            allowedGroups: Array.isArray(body.allowedGroups) ? body.allowedGroups : [],
            cooldownMs: Number(body.cooldownMs || 0) || 0,
            actions: Array.isArray(body.actions) ? body.actions : []
        });
        res.json({ success: true, command: created });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Erro ao criar comando', error: String(e?.message || e) });
    }
});

app.put('/api/dynamic-commands/:id', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        if (body.trigger) {
            body.trigger = normalizeTrigger(body.trigger);
            if (RESERVED_COMMANDS.has(body.trigger)) {
                const wantsOverride = body.overrideReserved === true || String(body.overrideReserved || '').toLowerCase() === 'true';
                if (!(ALLOW_RESERVED_OVERRIDE && wantsOverride)) {
                    return res.status(400).json({ success: false, message: 'Esse comando é reservado do sistema.' });
                }
            }
        }

        if (body.overrideReserved !== undefined) {
            body.overrideReserved = body.overrideReserved === true || String(body.overrideReserved || '').toLowerCase() === 'true';
        }
        body.updatedAt = new Date();
        const updated = await DynamicCommand.findByIdAndUpdate(req.params.id, body, { new: true });
        if (!updated) return res.status(404).json({ success: false, message: 'Não encontrado' });
        res.json({ success: true, command: updated });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Erro ao salvar', error: String(e?.message || e) });
    }
});

app.delete('/api/dynamic-commands/:id', requireAdmin, async (req, res) => {
    await DynamicCommand.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.post('/api/dynamic-commands/preview', requireAdmin, async (req, res) => {
    try {
        const { template, ctx } = req.body || {};
        const result = renderTemplate(template || '', ctx || {});
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Erro ao renderizar', error: String(e?.message || e) });
    }
});

app.get('/api/dynamic-commands/logs', requireAdmin, async (req, res) => {
    const trigger = (req.query.trigger || '').toString().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50) || 50));
    const q = trigger ? { trigger } : {};
    const logs = await CommandRunLog.find(q).sort({ at: -1 }).limit(limit);
    res.json({ success: true, logs });
});

async function ensureSystemConfigDoc() {
    try {
        // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
        if (mongoose.connection.readyState !== 1) return;
        const globalDoc = await SystemConfig.findOne({ key: 'global' }).lean();
        if (globalDoc) return;

        // Migra um doc legado (o mais recente) para virar o GLOBAL
        const legacy = await SystemConfig.findOne({}).sort({ _id: -1 });
        if (legacy) {
            legacy.key = 'global';
            if (legacy.allowedGroups == null) legacy.allowedGroups = [];
            if (legacy.systemInstruction == null) legacy.systemInstruction = '';
            if (legacy.botActive == null) legacy.botActive = true;
            await legacy.save();
            console.log('✅ SystemConfig legado migrado para key=global.');
            return;
        }

        await SystemConfig.create({ key: 'global', systemInstruction: '', allowedGroups: [], botActive: true });
        console.log('✅ SystemConfig criado automaticamente (defaults).');
    } catch (e) {
        console.error('❌ Falha ao criar SystemConfig automático:', String(e?.message || e));
    }
}

if (!MONGO_URI) {
    console.log('⚠️ MONGO_URI não definido no .env');
} else {
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log('✅ MongoDB Conectado');
            await ensureSystemConfigDoc();
        })
        .catch(e => console.error('❌ Erro ao conectar no MongoDB:', e));

    // Se reconectar mais tarde, garante o doc também
    mongoose.connection.on('connected', () => {
        ensureSystemConfigDoc();
    });
}

// ==========================================================
// 🤖 CORE DO BOT
// 🤖 CORE DO BOT
// 

let securityAuditTimer = null;
let securityAuditRunning = false;

async function enforceSecurityOnParticipant(groupJid, groupName, gConf, participantJid) {
    const cleanJid = normalizeUserJid(participantJid);
    const userNum = cleanID(cleanJid);

    const existing = await findExistingUserByJidOrPhone(cleanJid);
    if (existing?.isCanonized) return false;

    // 1) Embargo global
    if (existing?.embargo?.active) {
        await sock.sendMessage(groupJid, {
            text: `⚖️ *ACESSO NEGADO*\n\nO usuário @${userNum} está sob **EMBARGO INSTITUCIONAL** e foi removido preventivamente.`,
            mentions: [cleanJid]
        });
        await sock.groupParticipantsUpdate(groupJid, [cleanJid], 'remove');
        return true;
    }

    // 2) AutoBan (local ou comunidade)
    if (!gConf) r
    let banEntry = null;

    if (gConf.communityName) {
        const communityGroups = await GroupConfig.find({ communityName: gConf.communityName });
        const allBanned = communityGroups.flatMap(g => g.autoBanList || []);
        banEntry = allBanned.find(b => matchUserByJidOrPhone(cleanJid, b.jid) || phoneVariantsFromJid(cleanJid).includes(cleanID(b.jid)));
    } else {
        banEntry = (gConf.autoBanList || []).find(b => matchUserByJidOrPhone(cleanJid, b.jid) || phoneVariantsFromJid(cleanJid).includes(cleanID(b.jid)));
    }

    if (banEntry) {
        await sock.sendMessage(groupJid, {
            text: `📕 *SISTEMA DE AUTO-BAN*\n\nO usuário @${userNum} consta na lista negra deste setor e foi removido preventivamente.\n\n📄 *Motivo:* ${banEntry.reason || 'Sem motivo'}`,
            mentions: [cleanJid]
        });
        await sock.groupParticipantsUpdate(groupJid, [cleanJid], 'remove');
        return true;
    }

    return false;
}

async function auditGroupSecurity(groupJid) {
    try {
        const gConf = await GroupConfig.findOne({ jid: groupJid });
        const metadata = await sock.groupMetadata(groupJid);
        const groupName = metadata.subject || 'Setor';

        const botId = normalizeUserJid(sock.user.id);
        const botPart = metadata.participants.find(p => normalizeUserJid(p.id) === botId);
        const isBotAdmin = (botPart?.admin === 'admin' || botPart?.admin === 'superadmin');
        if (!isBotAdmin) return;

        const hasAutoBan = (gConf?.autoBanList?.length || 0) > 0 || !!gConf?.communityName;

        for (const p of metadata.participants) {
            const pJid = normalizeUserJid(p.id);
            if (pJid === botId) continue;

            if (!hasAutoBan) {
                const existing = await findExistingUserByJidOrPhone(pJid);
                if (!existing?.embargo?.active) continue;
            }
            await enforceSecurityOnParticipant(groupJid, groupName, gConf, pJid);
        }
    } catch (e) { }
}

async function auditAllGroupsSecurity() {
    if (!sock) return;
    if (securityAuditRunning) return;
    securityAuditRunning = true;
    try {
        const groups = await sock.groupFetchAllParticipating();
        const ids = Object.values(groups).map(g => g.id);
        for (const id of ids) {
            await auditGroupSecurity(id);
            await delay(250);
        }
    } catch (e) { }
    finally {
        securityAuditRunning = false;
    }
}

async function emitGroupsToWeb() {
    if (!sock) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject
        }));
        io.emit('groups', groupList);
    } catch (e) {
        console.log("Ainda carregando grupos...");
    }
}

let LAST_WEB_STATUS = 'Desconectado';
let LAST_WEB_QR = null;

io.on('connection', (socket) => {
    console.log('💻 Painel Web Conectado');
    // garante que quem abrir o painel depois recebe o estado atual
    socket.emit('status', LAST_WEB_STATUS);
    if (LAST_WEB_QR) socket.emit('qr', LAST_WEB_QR);
    emitGroupsToWeb();
});

const BOT_START_TIMESTAMP = Math.floor(Date.now() / 1000);

function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// Função auxiliar para desenhos arredondados
function drawRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

async function generateRG(user, photoUrl) {
    const canvasWidth = 800;
    const warnings = user.globalWarnings.concat(user.localWarnings).slice(0, 10);
    const cargos = user.cargos || [];

    // Altura dinâmica baseada no conteúdo
    const contentLines = Math.max(warnings.length, cargos.length, 1);
    const canvasHeight = 750 + (contentLines * 40);

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // --- 1. FUNDO E CAPA (EFEITO COVER) ---
    ctx.fillStyle = '#0f172a'; // Cor de fundo (Slate 900)
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (user.backgroundUrl) {
        try {
            const bg = await loadImage(user.backgroundUrl);
            const imgRatio = bg.width / bg.height;
            const targetRatio = canvasWidth / 400; // Área da capa é 800x400

            let dWidth, dHeight, sx, sy, sWidth, sHeight;

            // Lógica de "Object-fit: Cover"
            if (imgRatio > targetRatio) {
                sHeight = bg.height;
                sWidth = bg.height * targetRatio;
                sx = (bg.width - sWidth) / 2;
                sy = 0;
            } else {
                sWidth = bg.width;
                sHeight = bg.width / targetRatio;
                sx = 0;
                sy = (bg.height - sHeight) / 2;
            }

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, canvasWidth, 400);
            ctx.clip();
            ctx.drawImage(bg, sx, sy, sWidth, sHeight, 0, 0, canvasWidth, 400);
            ctx.restore();
        } catch (e) {
            console.log("Erro ao carregar background do RG");
        }
    }

    // Overlay gradiente para suavizar a transição da capa para o fundo
    const grd = ctx.createLinearGradient(0, 0, 0, 400);
    grd.addColorStop(0, 'rgba(15, 23, 42, 0.2)');
    grd.addColorStop(1, '#0f172a');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvasWidth, 400);

    // --- 2. PAINEL CENTRAL (GLASSMORPHISM) ---
    const panelY = 280;
    const panelHeight = canvasHeight - 320;

    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = '#1e293b'; // Slate 800
    drawRoundRect(ctx, 40, panelY, 720, panelHeight, 30);
    ctx.fill();
    ctx.restore();

    // Borda Temática (Dourado para Canonizado, Roxo para outros)
    ctx.lineWidth = 4;
    ctx.strokeStyle = user.isCanonized ? '#f59e0b' : '#7c3aed';
    drawRoundRect(ctx, 40, panelY, 720, panelHeight, 30);
    ctx.stroke();

    // --- 3. FOTO DE PERFIL CIRCULAR ---
    try {
        const pfp = await loadImage(photoUrl);
        ctx.save();
        ctx.shadowBlur = 25;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.arc(400, 280, 105, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(pfp, 295, 175, 210, 210);
        ctx.restore();

        // Aro da Foto
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#1e293b';
        ctx.beginPath(); ctx.arc(400, 280, 105, 0, Math.PI * 2); ctx.stroke();
    } catch (e) { }

    // --- 4. IDENTIFICAÇÃO ---
    ctx.textAlign = 'center';

    // Nome
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px Arial';
    ctx.fillText(user.name.toUpperCase(), 400, 440);

    // Patente / Status
    ctx.fillStyle = user.isCanonized ? '#f59e0b' : '#a78bfa';
    ctx.font = 'bold 24px Arial';
    const statusText = user.isCanonized ? '⚜️ CANONIZADO • ACADEMY LEGEND' : `PATENTE: ${user.rank.toUpperCase()}`;
    ctx.fillText(statusText, 400, 480);

    // Biografia
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'italic 21px Arial';
    const bioDisplay = user.bio.length > 65 ? user.bio.substring(0, 65) + "..." : user.bio;
    ctx.fillText(`"${bioDisplay}"`, 400, 520);

    // Divisória Visual
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(80, 550); ctx.lineTo(720, 550); ctx.stroke();

    // --- 5. COLUNAS DE DADOS ---
    const columnY = 590;

    // COLUNA ESQUERDA: CARGOS
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b5cf6';
    ctx.font = 'bold 26px Arial';
    ctx.fillText('🏅 CARGOS & TÍTULOS', 80, columnY);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '20px Arial';
    let nextY = columnY + 45;
    if (cargos.length === 0) {
        ctx.fillText('• Sem cargos atribuídos', 80, nextY);
    } else {
        cargos.forEach(c => {
            ctx.fillText(`• ${c.substring(0, 32)}`, 80, nextY);
            nextY += 38;
        });
    }

    // COLUNA DIREITA: ARQUIVO PENAL
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 26px Arial';
    ctx.fillText('📋 ARQUIVO PENAL', 430, columnY);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '20px Arial';
    nextY = columnY + 45;
    if (warnings.length === 0) {
        ctx.fillStyle = '#10b981';
        ctx.fillText('• Ficha Limpa', 430, nextY);
    } else {
        warnings.forEach(w => {
            const icon = w.id.includes('G') ? '🚩' : '📍';
            ctx.fillText(`${icon} ${w.reason.substring(0, 26)}`, 430, nextY);
            nextY += 38;
        });
    }

    // Rodapé Institucional
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '14px Arial';
    ctx.fillText(`REGISTRO OFICIAL ACADEMY • ID: ${user.phoneNumber} • ${moment().format('YYYY')}`, 400, canvasHeight - 30);

    return canvas.toBuffer();
}

const messageTracker = {}; // { groupJid: { userJid: { count: 0, lastText: "", lastTime: 0, stickers: 0 } } }

function checkSpam(jid, sender, content, isSticker, config) {
    if (!messageTracker[jid]) messageTracker[jid] = {};
    if (!messageTracker[jid][sender]) messageTracker[jid][sender] = { count: 0, lastText: "", lastTime: Date.now(), stickers: 0 };

    const user = messageTracker[jid][sender];
    const now = Date.now();
    const timeDiff = now - user.lastTime;

    // Resetar contador se o tempo passou
    if (timeDiff > (isSticker ? config.antisticker.windowMs : config.antispam.windowMs)) {
        user.count = 0;
        user.stickers = 0;
        user.lastTime = now;
    }

    // 1. Anti-Figurinha
    if (isSticker && config.antisticker.enabled) {
        user.stickers++;
        if (user.stickers > config.antisticker.limit) return { type: 'sticker', punishment: config.antisticker.punishment };
    }

    // 2. Anti-Spam
    if (config.antispam.enabled) {
        // Anti-Repetição
        if (config.antispam.antiRepeat && content === user.lastText && content.length > 5) {
            return { type: 'repetição', punishment: config.antispam.punishment };
        }
        user.lastText = content;
        user.count++;

        if (user.count > config.antispam.maxMsgs) return { type: 'flood', punishment: config.antispam.punishment };
    }

    return null;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({
        version: (await fetchLatestBaileysVersion()).version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Academy System", "Chrome", "1.0"]
    });

    // Proteções contra rate limit (429 / rate-overlimit)
    installBaileysGuards(sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. Gera e envia o QR Code
        if (qr) {
            console.log('⚠️ QR Code recebido, gerando imagem...');
            QRCode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error('❌ Erro ao gerar QR:', err);
                } else {
                    LAST_WEB_QR = url;
                    LAST_WEB_STATUS = 'Aguardando Leitura do QR';
                    io.emit('qr', url); // Envia a imagem base64 para o front
                    io.emit('status', 'Aguardando Leitura do QR');
                }
            });
        }

        // 2. Conexão estabelecida
        if (connection === 'open') {
            console.log('✅ BOT ONLINE E CONECTADO');
            LAST_WEB_STATUS = 'Online';
            LAST_WEB_QR = null;
            io.emit('status', 'Online');
            emitGroupsToWeb();

            // Auditoria automática de infiltração (Embargo/AutoBan)
            try {
                if (securityAuditTimer) clearInterval(securityAuditTimer);
                securityAuditTimer = setInterval(() => {
                    auditAllGroupsSecurity();
                }, SECURITY_AUDIT_INTERVAL_MS);
                setTimeout(() => auditAllGroupsSecurity(), 10_000);
            } catch (e) { }
        }

        // 3. Conexão caiu
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexão fechada. Reconectando...', shouldReconnect);

            LAST_WEB_STATUS = 'Desconectado';
            io.emit('status', 'Desconectado');

            if (securityAuditTimer) {
                clearInterval(securityAuditTimer);
                securityAuditTimer = null;
            }

            // Só reconecta se não foi logout manual
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('⛔ Logout realizado. Apague a pasta auth_info_baileys para gerar novo QR.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            // 1. TIMESTAMP & FILTRO DE ATRASO
            let msgTimestamp = msg.mstamp;
            if (typeof msgTimestamp === 'object') msgTimestamp = msgTimestamp.low;
            if (msgTimestamp < BOT_START_TIMESTAMP - 5) return;

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');

            // 2. EXTRAÇÃO DE TEXTO (MOVIDO PARA CIMA)
            const content = (msg.me||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || "").trim();

            // ============================================================
            // 🧪 MODO TESTE: OUVIR COMANDOS DO PRÓPRIO BOT (fromMe)
            // =============================
            if (msg.key.fromMe) {
                if (!HEAR_SELF_COMMANDS) return;
                if (!content || !content.startsWith('!')) return;

                if (HEAR_SELF_ALLOWED_JIDS.size > 0 && !HEAR_SELF_ALLOWED_JIDS.has(jid)) return;

                const msgId = msg.key.id;
                if (msgId) {
                    const now = Date.now();
                    for (const [k, ts] of selfCommandSeen) {
                        if (now - ts > 60_000) selfCommandSeen.delete(k);
                    }
                    if (selfCommandSeen.has(msgId)) return;
                    selfCommandSeen.set(msgId, now);
                }
            }

            // 3. DETECÇÃO DE REMETENTE E DADOS (CORRIGIDO)
            let sender = msg.key.fromMe
            let sender = msg.key.fromMe ? sock.user.id : (isGroup ? (msg.key.participant || msg.participant) : jid);
            const cleanSender = jidNormalizedUser(sender);
            const senderNumber = cleanID(cleanSender);

            // 4. CARREGAMENTO DE DADOS
            const user = await getUser(cleanSender, msg.pushName);
            const gConf = isGroup ? await GroupConfig.findOne({ jid }) : null;

            // 5. DEFINIÇÃO DE HIERARQUIAeplace(/\D/g, ''));
            const isDev = user.rank === 'Dev' || isOwner;
            const isMaster = user.rank === 'Master' || isDev;

            // 6. VERIFICAÇÃO DE ADMINS
            let isAdmin = false;
            let isSuperAdmin = false;
            let groupName = isGroup ? "Carregando..." : "PV";

            if (isGroup) {
                try {
                    const groupMetadata = await sock.groupMetadata(jid);
                    groupName = groupMetadata.subject;
                    const participant = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === cleanSender);
                    isAdmin = (participant?.admin === 'admin' || participant?.admin === 'superadmin');
                    const botId = jidNormalizedUser(sock.user.id);
                    const botPart = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === botId);
                    isSuperAdmin = (botPart?.admin === 'admin' || botPart?.admin === 'superadmin');
                } catch (e) { }
            }

            // ============================================================
            // 🛡️ FILTRO ANTI-SPAM & ANTI-FIGURINHA (AGORA COM VARIÁVEIS CERTAS)
            // =====================================
            if (isGroup && isSuperAdmin && !isOwner && !user.isCanonized && gConf) {
                const isSticker = !!msg.message.stickerMessage;
                const violation = checkSpam(jid, cleanSender, content, isSticker, gConf);

                if (violation) {
                    await sock.sendMessage(jid, { delete: msg.key });
                    const punicao = violation.punishment;
                    const reason = `Sistema Anti-Spam: Excesso de ${violation.type}`;

                    if (punicao === 'ban') {
                        await sock.sendMessage(jid, { text: `🚫 @${senderNumber} foi banido por flood de ${violation.type}.`, mentions: [cleanSender] });
                        await sock.groupParticipantsUpdate(jid, [cleanSender], 'remove');
                    } else {
                        const isGlobal = punicao === 'global';
                        const id = getNextId(isGlobal ? user.globalWarnings : user.localWarnings, isGlobal ? 'ADVG' : 'ADV');
                        if (isGlobal) {
                            user.globalWarnings.push({ id, reason, admin: "SYSTEM", date: new Date() });
                            await sock.sendMessage(jid, { text: `⚠️ @${senderNumber} recebeu uma ADV GLOBAL por spam.`, mentions: [cleanSender] });
                        } else {
                            user.localWarnings.push({ id, groupJid: jid, groupName, reason, admin: "SYSTEM", date: new Date() });
                            await sock.sendMessage(jid, { text: `⚠️ @${senderNumber} advertido por excesso de ${violation.type} (${user.localWarnings.length}/3).`, mentions: [cleanSender] });
                        }
                        await user.save();
                    }
                    return;
                }
            }

            // ============================================================
            // ⚖️ ESCUDO DE SEGURANÇA (EMBARGO E AUTOBAN)
            // ========================================
            if (isGroup && isSuperAdmin && !msg.key.fromMe && !user.isCanonized) {
                const acted = await enforceSecurityOnParticipant(jid, groupName, gConf, cleanSender);
                if (acted) return;
            }

            // 7. REGISTRO DE ATIVIDADE
            if (isGroup) {
                await trackGroupActivity(user, jid, groupName, isAdmin ? 'Admin' : 'Membro');
                if (gConf?.communityName) await updateCommunityActivity(gConf.communityName, 1);
            }

            // 8. PROCESSAMENTO DE COMANDOS
            if (!content || !content.startsWith('!')) return;

            const args = content.trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const argText = content.slice(command.length + 1).trim();
            let target;
            let tUser;

            // --- 🤖 PROTOCOLO DE ATIVAÇÃO (!bot on/off) ---
            if (command === '!bot') {
                await showTypingPresence(jid, 700);
                const sub = args[0]?.toLowerCase();
                if (sub !== 'on' && sub !== 'off') {
                    return sock.sendMessage(jid, { text: '🏛️| *DIRETRIZ ACADEMY*\nUse: !bot on ou !bot off para gerenciar o núcleo.' });
                }

                const isOn = sub === 'on';

                // 1. ATIVAÇÃO GLOBAL (Apenas para DEVS)
                // Se um Dev der !botna Whitelist permanente do banco de dados
                if (isDev && isOn) {
                    const sys = await SystemConfig.findOne({ key: 'global' }) || await SystemConfig.create({ key: 'global', allowedGroups: [] });
                    if (!sys.allowedGroups.includes(jid)) {
                        await SystemConfig.updateOne({ key: 'global' }, { $push: { allowedGroups: jid } });
                        console.log(`🏛️ Setor ${jid} autorizado globalmente por um Diretor.`);
                    }
                }

                // 2. CHECAGEM DE PATENTE (Precisa ser no mínimo Master para o bot responder)
                if (!isMaster) return;

                // 3. ATUALIZAÇÃO DO STATUS LOCAL
                await GroupConfig.findOneAndUpdate(
                    { jid },
                    { botActive: isOn },
                    { upsert: true }
                );

                // 4. MENSAGENS COM ESTÉTICA ACADEMY
                const msgAtivado = `🏛️ *NÚCLEO ACADEMY ESTABELECIDO* 🏛️\n\n` +
                    `O sistema central foi vinculado com sucesso a este setor. Todos os protocolos de RPG, Moderação e Mail estão agora **OPERACIONAIS**.\n\n` +
                    `_Ordem e Excelência._ 💜`;

                const msgDesativado = `🏛️ *NÚCLEO ACADEMY EM HIBERNAÇÃO* 🏛️\n\n` +
                    `Por determinação superior, os serviços automáticos deste setor foram suspendidos. O bot permanecerá em modo de observação silenciosa.\n\n` +
                    `_Até breve._ 💜`;

                return sock.sendMessage(jid, { text: isOn ? msgAtivado : msgDesativado });
            }

            // 9. WHITELIST GLOBAL
            const sysConfig = await SystemConfig.findOne({ key: 'global' });
            const allowed = sysConfig?.allowedGroups || [];
            if (!isDev && isGroup && !allowed.includes(jid)) return;

            // Se for um comando reservado (hardcoded), deixa mais "bonito" com presença de digitação
            if (RESERVED_COMMANDS.has(commalog presença.
            if (RESERVED_COMMANDS.has(command)) {
                await showTypingPresence(jid, 700);
            }

            // ============================================================
            // 🧩 COMANDOS DINÂMICOS===========
            try {
                const dyn = await DynamicCommand.findOne({ trigger: command, enabled: true });
                const canOverrideReserved = !!(ALLOW_RESERVED_OVERRIDE && dyn?.overrideReserved && RESERVED_COMMANDS.has(command));
                const canRunDynamic = !!dyn && (!RESERVED_COMMANDS.has(command) || canOverrideReserved);

                if (canRunDynamic) {
                    if (isGroup && Array.isArray(dyn.allowedGroups) && dyn.allowedGroups.length > 0 && !dyn.allowedGroups.includes(jid)) {
                        return;
                    }

                    const effectiveRank = isDev ? 'Dev' : (user.rank === 'Coord' ? 'Coord' : (isMaster ? 'Master' : user.rank));
                    if (getRankLevel(effectiveRank) < getRankLevel(dyn.rankRequired)) {
                        return sock.sendMessage(jid, { text: `⚠️ Acesso restrito a ${dyn.rankRequired} e superiores.` });
                    }

                    const cdMs = Number(dyn.cooldownMs || 0) || 0;
                    if (cdMs > 0) {
                        const cdKey = `${jid}:${cleanSender}:${dyn.trigger}`;
                        const last = commandCooldowns.get(cdKey) || 0;
                        const now = Date.now();
                        if (now - last < cdMs) return;
                        commandCooldowns.set(cdKey, now);
                    }

                    await showTypingPresence(jid, 800);

                    let outputs = [];
                    try {
                        outputs = await executeDynamicCommand({
                            sock,
                            msg,
                            jid,
                            isGroup,
                            user,
                            groupName,
                            isAdmin,
                            isSuperAdmin,
                            isOwner,
                            isDev,
                            isMaster,
                            cleanSender,
                            content,
                            args,
                            argText,
                            commandDef: dyn
                        });
                        await CommandRunLog.create({
                            trigger: dyn.trigger,
                            commandId: dyn._id,
                            jid,
                            isGroup,
                            sender: cleanSender,
                            senderName: user?.name || msg.pushName || 'Desconhecido',
                            ok: true,
                            outputs
                        });
                        io.emit('cmdlog', { at: new Date().toISOString(), trigger: dyn.trigger, jid, sender: cleanSender, ok: true, outputs });
                        return;
                    } catch (e) {
                        await CommandRunLog.create({
                            trigger: dyn.trigger,
                            commandId: dyn._id,
                            jid,
                            isGroup,
                            sender: cleanSender,
                            senderName: user?.name || msg.pushName || 'Desconhecido',
                            ok: false,
                            outputs,
                            error: String(e?.message || e)
                        });
                        io.emit('cmdlog', { at: new Date().toISOString(), trigger: dyn.trigger, jid, sender: cleanSender, ok: false, error: String(e?.message || e) });
                        return sock.sendMessage(jid, { text: '❌ Erro ao executar comando dinâmico.' });
                    }
                }
            } catch (e) { }

            // Função para pegar alvo nos comandos
            const getTarget = () => {
                let target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!target && args[0]) {
                    const cleanNum = args[0].replace(/\D/g, '');
                    if (cleanNum.length >= 8) target = cleanNum + '@s.whatsapp.net';
                }
                return target;
            };

            // Exemplo de como usar a nova identificação por número no !kick:
            if (command === '!kick') {
                if (!isAdmin && !isMaster) return;

                // 1. Identifica o alvo (ID pronto)
                target = getTarget();
                if (!target) return sock.sendMessage(jid, { text: '❌ Mencione o usuário ou digite o número.' });

                // 2. Busca dados no Banco
                tUser = await getUser(target);

                // 3. Checa Imunidade
                if (tUser.isCanonized) {
                    return sock.sendMessage(jid, { text: '> Santos não podem sofrer punições.\n\n> Academy System 3.0 💜' });
                }

                // 4. Executa a expulsão
                const gConf = await GroupConfig.findOne({ jid });
                if (gConf?.communityName) {
                    const comm = await Community.findOne({ name: gConf.communityName });
                    await sock.sendMessage(jid, { text: `🧩 Expulsão Comunitária: Removendo @${cleanID(target)} de todos os setores de *${comm.name}*...`, mentions: [target] });
                    for (const gId of comm.groups) {
                        try { await sock.groupParticipantsUpdate(gId, [target], 'remove'); } catch (e) { }
                    }
                } else {
                    if (!isSuperAdmin) return sock.sendMessage(jid, { text: '❌ O bot precisa ser Admin para expulsar.' });
                    await sock.groupParticipantsUpdate(jid, [target], 'remove');
                    await sock.sendMessage(jid, { text: `🚪 Removido: @${cleanID(target)}`, mentions: [target] });
                }
                return;
            }

            try {
                // ============================================================
                // 🛡️ SISTEMA PENAL ACADEMY (ADV) - VERSÃO FINAL 3.0
                // ===================================
                if (command === '!adv') {
                    if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Acesso restrito a Masters e Superiores.' });

                    // 1. Identifica o alvo
                    target = getTarget();
                    if (!target) return sock.sendMessage(jid, { text: '❌ Erro: Mencione o usuário ou digite o número.\nEx: !adv @usuario | Motivo' });

                    // 2. Busca dados
                    tUser = await getUser(target);

                    // 3. Checa Imunidade
                    if (tUser.isCanonized) {
                        return sock.sendMessage(jid, { text: '> Santos não podem sofrer punições.\n\n> Academy System 3.0 💜' }, { quoted: msg });
                    }

                    // 4. Processa Argumentos
                    const fullArgs = argText.split('|').map(a => a.trim());
                    const isGlobal = args[0]?.toLowerCase() === 'global';
                    const reason = (isGlobal ? fullArgs[1] : fullArgs[1]) || "Sem motivo especificado";
                    const adminName = user.name;
                    const gConf = await GroupConfig.findOne({ jid });

                    // --------------------------------------------------------
                    // MODO: ADVERTÊNCIA GLOBAL
                    // --------------------------------------------------------
                    if (isGlobal) {
                        const durationStr = fullArgs[2] || "30d";
                        const id = getNextId(tUser.globalWarnings, 'ADVG');
                        const endDate = parseDuration(durationStr);

                        tUser.globalWarnings.push({ id, reason, admin: adminName, duration: durationStr, endDate });

                        // Mensagem para o Privado
                        const msgPvGlobal = `📓| *NOTIFICAÇÃO INSTITUCIONAL*\n\nCaro(a) @${cleanID(target)},\n\nVocê recebeu uma **ADVERTÊNCIA GLOBAL** no sistema Academy.\n\n📄 *Motivo:* ${reason}\n⏳ *Duração:* ${durationStr}\n👮 *Por:* ${adminName}\n\n_Mantenha uma conduta ética para evitar o embargo de sua conta._ 💜`;
                        await sock.sendMessage(target, { text: msgPvGlobal, mentions: [target] });

                        if (tUser.globalWarnings.length >= 5) {
                            tUser.embargo = { active: true, reason: "Acúmulo de 5 ADVs Globais", since: new Date(), admin: "SYSTEM", duration: "Permanente" };
                            await sock.sendMessage(jid, { text: `⛔ *EMBARGO ATIVADO*\nO usuário @${cleanID(target)} atingiu o limite de 5 advertências globais e foi banido da rede.`, mentions: [target] });
                            if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [target], 'remove');
                        } else {
                            await sock.sendMessage(jid, { text: `🟣 *ADV GLOBAL APLICADA*\n@${cleanID(target)} recebeu sua ${tUser.globalWarnings.length}ª advertência.\nMotivo: ${reason}`, mentions: [target] });
                        }
                    }
                    // --------------------------------------------------------
                    // MODO: ADVERTÊNCIA LOCAL
                    // --------------------------------------------------------
                    else {
                        const id = getNextId(tUser.localWarnings, 'ADV');
                        tUser.localWarnings.push({ id, groupJid: jid, groupName, reason, admin: adminName });

                        // Cálculo de ADVs
                        let localCount;
                        let community = null;
                        if (gConf?.communityName) {
                            community = await Community.findOne({ name: gConf.communityName });
                            localCount = tUser.localWarnings.filter(w => community.groups.includes(w.groupJid)).length;
                        } else {
                            localCount = tUser.localWarnings.filter(w => w.groupJid === jid).length;
                        }

                        // Mensagem para o Privado
                        const localLocation = community ? `na comunidade *${community.name}*` : `no grupo *${groupName}*`;
                        const msgPvLocal = `📕| *AVISO DE ADVERTÊNCIA*\n\nVocê recebeu uma advertência ${localLocation}.\n\n⚖️ *ID:* ${id}\n📄 *Razão:* ${reason}\n👮 *Por:* ${adminName}\n📉 *Status:* ${localCount}/3 ADVs\n\n_Ao atingir 3 advertências, você será removido automaticamente._`;
                        await sock.sendMessage(target, { text: msgPvLocal, mentions: [target] });

                        // Checa limite de banimento (3 ADVs)
                        if (localCount >= 3) {
                            const banReason = community ? `Limite de ADVs na Comunidade ${community.name}` : `Limite de ADVs no Grupo`;

                            // Registra no AutoBan
                            await GroupConfig.findOneAndUpdate({ jid }, { $push: { autoBanList: { jid: target, reason: banReason, admin: "SYSTEM" } } });

                            if (community) {
                                await sock.sendMessage(jid, { text: `🚫 *EXPULSÃO COMUNITÁRIA*\nO usuário @${cleanID(target)} atingiu 3 advertências na comunidade *${community.name}* e será removido de todos os setores.`, mentions: [target] });
                                for (const gJid of community.groups) {
                                    try { await sock.groupParticipantsUpdate(gJid, [target], 'remove'); } catch (e) { }
                                }
                            } else {
                                await sock.sendMessage(jid, { text: `🚫 *BANIMENTO POR ADVERTÊNCIA*\n@${cleanID(target)} atingiu 3 advertências e foi removido do grupo.`, mentions: [target] });
                                if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [target], 'remove');
                            }
                        } else {
                            await sock.sendMessage(jid, { text: `📕| @${cleanID(target)} recebeu ${localCount}/3 advertências!\nRazão: ${reason}\nLocal: ${community ? 'Comunidade ' + community.name : 'Grupo'}`, mentions: [target] });
                        }
                    }

                    await tUser.save();
                    return;
                }

                if (command === '!menu' || command === '!help') {
                    // Se não tiver argumentos, mostra o menu
                    if (args.length === 0) {
                        const allCmds = await CommandDoc.find().sort({ category: 1, trigger: 1 });

                        // Ícones e Estilo
                        let menuText = `╭━━ 🏛️ *ACADEMY SYSTEM* 🏛️ ━━╮\n`;
                        menuText += `┃ 👤 *Olá, ${user.name}*\n`;
                        menuText += `┃ 🛡️ *Patente:* ${user.rank.toUpperCase()}\n`;
                        menuText += `┃ 📅 *Data:* ${moment().format('DD/MM')}\n`;
                        menuText += `╰━━━━━━━━━━━━━━━━━━━━╯\n\n`;

                        if (allCmds.length === 0) {
                            menuText += "_⚠️ O Grimoire está vazio. Use !help add para escrever._";
                        }

                        // Agrupar por Categoria
                        const categories = {};

                        allCmds.forEach(cmd => {
                            // Filtro de Visibilidade (Membro não vê comando de Dev)
                            let show = false;
                            if (user.rank === 'Dev' || isOwner) show = true;
                            else if (user.rank === 'Master' && (cmd.rankRequired === 'Master' || cmd.rankRequired === 'Membro')) show = true;
                            else if (cmd.rankRequired === 'Membro') show = true;

                            if (show) {
                                if (!categories[cmd.category]) categories[cmd.category] = [];
                                categories[cmd.category].push(cmd);
                            }
                        });

                        // Montar o Texto
                        for (const [cat, cmds] of Object.entries(categories)) {
                            menuText += `╭─ ${cat} ───\n`;
                            cmds.forEach(c => {
                                menuText += `│ ➪ *${c.trigger}* - _${c.description}_\n`;
                            });
                            menuText += `╰───────────────────\n\n`;
                        }

                        menuText += `_Academy System v3.0_ 💜`;

                        // Envia com foto de perfil do bot ou imagem padrão
                        let botPfp;
                        try { botPfp = await sock.profilePictureUrl(sock.user.id, 'image'); }
                        catch { botPfp = 'https://i.imgur.com/62j1H2p.png'; } // Logo Academy genérica

                        await sock.sendMessage(jid, { image: { url: botPfp }, caption: menuText }, { quoted: msg });
                        return;
                    }

                    // SUB-COMANDO: !help add
                    if (args[0] === 'add') {
                        if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVS podem escrever no Grimoire.' });

                        // Sintaxe: !help add Categoria | !comando | Descrição | Rank
                        const params = argText.replace('add', '').trim().split('|').map(a => a.trim());

                        if (params.length < 3) {
                            return sock.sendMessage(jid, {
                                text: '❌ *Formato Incorreto!*\nUse:\n!help add Categoria | !comando | Descrição | Rank(Opcional)\n\nEx:\n!help add ⚖️ MODERAÇÃO | !adv | Adverte membro | Master'
                            });
                        }

                        const category = params[0];
                        const trigger = params[1].startsWith('!') ? params[1] : '!' + params[1];
                        const desc = params[2];
                        const rank = params[3] ? params[3] : 'Membro'; // Padrão Membro

                        await CommandDoc.findOneAndUpdate(
                            { trigger },
                            { category, description: desc, rankRequired: rank },
                            { upsert: true }
                        );

                        return sock.sendMessage(jid, { text: `✅ *Comando Registrado!*\n\n📝 ${trigger}\n📂 ${category}\n🔒 Rank: ${rank}` });
                    }

                    // SUB-COMANDO: !help del
                    if (args[0] === 'del') {
                        if (!isDev) return;
                        const trigger = args[1].startsWith('!') ? args[1] : '!' + args[1];
                        await CommandDoc.deleteOne({ trigger });
                        return sock.sendMessage(jid, { text: `🗑️ Comando ${trigger} removido do Grimoire.` });
                    }
                }

                if (command === '!rmadv') {
                    if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Acesso restrito a Masters e Superiores.' });

                    // 1. Identifica o alvo
                    target = getTarget();
                    if (!target) return sock.sendMessage(jid, { text: '❌ Mencione o usuário ou digite o número para remover a ADV.' });

                    // 2. Busca dados
                    tUser = await getUser(target);
                    const gConf = await GroupConfig.findOne({ jid });

                    // 3. Processa Argumentos
                    const isGlobal = args[0]?.toLowerCase() === 'global';
                    
                    // Tenta pegar o ID após a barra vertical '|'
                    const parts = argText.split('|').map(p => p.trim());
                    const specificId = parts.length > 1 ? parts[1].toUpperCase() : null; // Se tiver ID, usa ele

                    let removedAdv = null;
                    let currentCount = 0;
                    let contextName = "";

                    // --------------------------------------------------------
                    // MODO: REMOÇÃO GLOBAL
                    // --------------------------------------------------------
                    if (isGlobal) {
                        contextName = "Rede Academy (Global)";
                        
                        if (tUser.globalWarnings.length === 0) {
                            return sock.sendMessage(jid, { text: '❌ Este usuário não possui advertências globais.' });
                        }

                        if (specificId) {
                            // Remove por ID específico
                            const index = tUser.globalWarnings.findIndex(w => w.id === specificId);
                            if (index === -1
                            const index = tUser.globalWarnings.findIndex(w => w.id === specificId);
                            if (index === -1) return sock.sendMessage(jid, { text: `❌ ID Global *${specificId}* não encontrado para este usuário.` });
                            removedAdv = tUser.globalWarnings.splice(index, 1)[0];
                        } else {
                            // Remove última
                            removedAdv = tUser.globalWarnings.pop();
                        }
                        
                        currentCount = tUser.globalWarnings.length;

                        // Se estava embargado remove
                        if (tUser.embargo.active && tUser.embargo.reason.includes("5 ADVs") && currentCount < 5) {
                            tUser.embargo.active = false;
                            await sock.sendMessage(jid, { text: `⚖️ *EMBARGO REVOGADO*\nCom a remoção da ADV, @${cleanID(target)} saiu da zona de banimento automático.`, mentions: [target] });
                        }
                    } 
                    // --------------------------------------------------------
                    // MODO: REMOÇÃO LOCAL
                    // --------------------------------------------------------
                    else {
                        // Contexto
                        let community = null;
                        if (gConf?.communityName) {
                            community = await Community.findOne({ name: gConf.communityName });
                            contextName = `Comunidade ${community.name}`;
                        } else {
                            contextName = `Grupo ${groupName}`;
                        }

                        if (tUser.localWarnings.length === 0) {
                            return sock.sendMessage(jid, { text: '❌ Este usuário não possui advertências locais.' });
                        }

                        if (specificId) {
                            // Remove por ID
                            const index = tUser.localWarnings.findIndex(w => w.id === specificId);
                            if (index === -1) return sock.sendMessage(jid, { text: `❌ ID Local *${specificId}* não encontrado.` });
                            removedAdv = tUser.localWarnings.splice(index, 1)[0];
                        } else {
                            // Remove última do contexto
                            let indexToRemove = -1;
                            
                                const belongsToContext = community ? community.groups.includes(w.groupJid) : w.groupJid === jid;
                                if (belongsToContext) {
                                    indexToRemove = i;
                                    break;
                                }
                            }

                            if (indexToRemove === -1) return sock.sendMessage(jid, { text: '❌ Nenhuma advertência encontrada neste contexto para remover.' });
                            removedAdv = tUser.localWarnings.splice(indexToRemove, 1)[0];
                        }

                        // Recalcula contagem local
                        if (community) {
                            currentCount = tUser.localWarnings.filter(w => community.groups.includes(w.groupJid)).length;
                        } else {
                            currentCount = tUser.localWarnings.filter(w => w.groupJid === jid).length;
                        }
                    }

                    await tUser.save();

                    // 4. Feedback no Grupo
                    let res = `⚖️ *REVISÃO PENAL ACADEMY*\n\n`;
                    res += `A advertência de @${cleanID(target)} foi revogada com sucesso.\n\n`;
                    res += `🗑️ *Removido:* ${removedAdv.id}\n`;
                    res += `📄 *Motivo Original:* ${removedAdv.reason}\n`;
                    res += `📉 *Novo Status:* ${currentCount} ADVs (${contextName})\n\n`;
                    res += `_Ação Administrativa por: ${user.name}_`;

                    await sock.sendMessage(jid, { text: res, mentions: [target] });

                    // 5. Feedback no PV
                    const msgPv = `⚖️| *AVISO DE REMOÇÃO DE PENA*\n\nOlá.\nUma de suas advertências em *${contextName}* foi removida após reavaliação.\n\nID: ${removedAdv.id}\nStatus Atual: ${currentCount}\n\n_Continue colaborando com a ordem._ 💜`;
                    try { await sock.sendMessage(target, { text: msgPv }); } catch (e) {}
                    
                    // Se foi removido do AutoBanList (caso estivesse banido por advs), verifica e remove
                    if (!isGlobal && currentCount < 3) {
                         const wasBanned = gConf?.autoBanList.find(b => b.jid === target && b.reason.includes("Limite de ADVs"));
                         if (wasBanned) {
                             await GroupConfig.findOne
                                { jid },
                                { $pull: { autoBanList: { jid: target } } }
                            );
                            await sock.sendMessage(jid, { text: `🔓 @${cleanID(target)} foi removido do Auto-Ban pois suas ADVs caíram para menos de 3.`, mentions: [target] });
                         }
                    }
                    
                    return;
                }

                if (command === '!listadv' || command === '!listaadv') {
                    const targetArg = args[0] === 'global' ? args[1] : args[0];
                    const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    let targetJid = mentionedJid ? mentionedJid : (targetArg ? targetArg.replace(/\D/g, '') + '@s.whatsapp.net' : cleanSender);

                    const tUser = await getUser(targetJid);

                    if (args[0] === 'global') {
                        let txt = `「🗃️ ≡ Seção de Advertências Globais (@${cleanID(targetJid)})\n\n`;
                        tUser.globalWarnings.forEach(w => {
                            txt += `📋| ${w.id}\n- ${w.reason}\n> Em: ${moment(w.date).format('DD/MM/YY HH:mm')}\n> Tempo: ${w.duration}\n\n`;
                        });
                        txt += `\n「🗂️ ≡ Seção de Advertências Locais\n\n`;
                        tUser.localWarnings.forEach(w => {
                            txt += `🗒️| ${w.id}\n- ${w.reason}\n> Onde: ${w.groupName}\n> Em: ${moment(w.date).format('DD/MM/YY')}\n\n`;
                        });
                        await sock.sendMessage(jid, { text: txt, mentions: [targetJid] });
                    } else {
                        let txt = `🍻 Advertências Locais de @${cleanID(targetJid)}\n\n`;
                        const localAdvs = tUser.localWarnings.filter(w => w.groupJid === jid);
                        localAdvs.forEach(w => {
                            txt += `🗒️| ${w.id}\n- ${w.reason}\n> Por: ${w.admin}\n> Em: ${moment(w.date).format('DD/MM/YY')}\n\n`;
                        });
                        if (localAdvs.length === 0) txt += "Nenhuma advertência neste grupo.";
                        await sock.sendMessage(jid, { text: txt, mentions: [targetJid] });
                    }
                    return;
                }

                // ===================================
                // ⚖️ SISTEMA DE EMBARGO
                // ===================================
                if (command === '!embargo') {
                    if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVS podem gerenciar o Embargo.' });

                    const action = args[0]?.toLowerCase();
                    const now = moment();

                    // --- AÇÃO: ADICIONAR EMBARGO ---
                    if (action === 'add') {
                        const params = argText.split('|').map(a => a.trim());

                        if (!target || params.length < 4) {
                            return sock.sendMessage(jid, { text: '❌ *ERRO DE SINTAXE*\nUse: !embargo add @user | motivo | tempo | link' });
                        }

                        const reason = params[1];
                        const duration = params[2];
                        const link = params[3];
                        const endDate = parseDuration(duration);

                        tUser = await getUser(target);
                        if (tUser.isCanonized) return sock.sendMessage(jid, { text: '> Santos não podem sofrer punições.\n\n> Academy System 3.0 💜' });

                        // 1. Registro no Banco
                        await UserProfile.findOneAndUpdate({ jid: target }, {
                            embargo: { active: true, reason, link, duration, since: new Date(), admin: user.name, endDate }
                        });

                        // 2. Notificação Formal no Privado (Bonitinha)
                        const msgPV = `*⚖️| EMBARGO INSTITUCIONAL ACADEMY*\n` +
                            `> Envio: ${now.format('DD/MM/YY • HH:mm')}\n` +
                            `> De: diretoria@mail.acdm\n\n` +
                            `Caro(a) @${cleanID(target)},\n`
                            `O Instituto Academy de RPGistas, por determinação da Diretoria Academy (DEVS+), declara o **EMBARGO** de sua participação em todas as redes, espaços e plataformas associadas à Academy.\n\n` +
                            `*JUSTIFICATIVA:*\n${reason}\n\n` +
                            `*Registro Interno:* ${link}\n` +
                            `*Tempo de Embargo:* ${duration}\n\n` +
                            `Atenciosamente, DEVS+ 💜\n` +
                            `_Diretoria de Desenvolvimento Academy_`;

                        await sock.sendMessage(target, { text: msgPV, mentions: [target] });

                        // 3. Notificar Diretoria
                        try {
                            await sock.sendMessage(ID_GRUPO_DIRETORIA, {
                                text: `⚖️| *NOTIFICAÇÃO DE EMBARGO*\nAlvo: @${cleanID(target)}\nMotivo: ${reason}`,
                                mentions: [target]
                            });
                        } catch (e) { }

                        // ============================================================
                        // 🚀 MOTOR DE VARREDURA ACADEMY (FIX: SUPORTE A LID)
                        // ============================================================
                        await sock.sendMessage(jid, { text: `⏳ *Varredura Academy Iniciada...* Localizando infrator e validando LIDs.` });

                        // 🚀 MOTOR DE VARREDURA
                        // (allGroupsObj);

                        // Pega TODAS as identidades possíveis do Bot
                        const myId = jidNormalizedUser(sock.user.id);
                        const myLid = sock.user.lid || myId; // Pega o LID se o Baileys já souber
                        const targetNormalized = jidNormalizedUser(target);

                        let count = 0;

                        for (const group of groups) {
                            try {
                                const freshMeta = await sock.groupMetadata(group.id);
                                const participants = freshMeta.participants;

                                // 1. O alvo está no grupo?
                                const isPresent = participants.find(p => jidNormalizedUser(p.id) === targetNormalized);

                                if (isPresent) {
                                    // 2. Encontra o BOT na lista (compara por ID ou por LID)
                                    const meInGroup = participants.find(p => {
                                        const pId = jidNormalizedUser(p.id);
                                        return pId === myId || pId === myLid;
                                    });

                                    // Verifica se o bot tem o cargo
                                    const botIsAdmin = meInGroup && (meInGroup.admin === 'admin' || meInGroup.admin === 'superadmin');

                                    if (botIsAdmin) {
                                        await sock.groupParticipantsUpdate(group.id, [targetNormalized], 'remove');
                                        count++;
                                    } else {
                                        // Fallback: Se o bot é admin mas o ID não bateu, tenta forçar o kick
                                        // Às vezes o Baileys não popula o cargo no cache, mas o comando funciona
                                        try {
                                            await sock.groupParticipantsUpdate(group.id, [targetNormalized], 'remove');
                                            count++;
                                        } catch (e) {
                                            console.log(`🚫 Sem permissão real em: ${freshMeta.subject}`);
                                        }
                                    }
                                }
                                await delay(1000);
                            } catch (err) { console.log(`Erro no grupo ${group.id}`); }
                        }

                        return sock.sendMessage(jid, {
                            text: `✅ *EMBARGO FINALIZADO*\n\nInfrator: @${cleanID(target)}\nSetores Limpos: *${count}*\n\n_O bloqueio institucional de re-entrada foi ativado com sucesso._ 💜`,
                            mentions: [target]
                        });
                    }
                    // --- AÇÃO: REMOVER / REDUZIR ---
                    if (action === 'rmv') {
                        if (!target) return sock.sendMessage(jid, { text: '❌ Mencione o usuário.' });

                        const params = argText.split('|').map(a => a.trim());
                        tUser = await getUser(target);

                        if (!tUser.embargo || !tUser.embargo.active) {
                            return sock.sendMessage(jid, { text: '⚖️ Este usuário não possui um embargo ativo.' });
                        }

                        const reduction = params[1];
                        tUser.embargo.active = false;
                        await tUser.save();

                        const msgRmv = `*⚖️| EMBARGO INSTITUCIONAL ACADEMY*\n\nCaro @${cleanID(target)},\n\nSeu embargo foi revogado pela Diretoria DEVS+. Você está livre para retornar.\n\nAtenciosamente, DEVS+ 💜`;

                        // ✅ CORREÇÃO: Sem mentions no PV
                        await sock.sendMessage(target, { text: msgRmv });
                        return sock.sendMessage(jid, { text: `✅ Embargo de @${cleanID(target)} revogado.`, mentions: [target] });
                    }

                    // --- AÇÃO: LISTAR EMBARGADOS ---
                    if (action === 'list') {
                        const list = await UserProfile.find({ 'embargo.active': true });
                        let res = `⚖️| *EMBARGADOS DO INSTITUTO ACADEMY*\n> Total: ${list.length}\n\n`;
                        list.forEach(u =
                            res += `🔐| @${cleanID(u.jid)} | ${u.embargo.duration}\n`;
                        });
                        return sock.sendMessage(jid, { text: res, mentions: list.map(l => l.jid) });
                    }

                    // --- AÇÃO: BUSCAR (busq) ---
                    if (action === 'busq') {
                        await sock.sendMessage(jid, { text: '⚖️| *INICIANDO BUSCA GLOBAL...*' });
                        const embargados = await UserProfile.find({ 'embargo.active': true });
                        const allGroups = await sock.groupFetchAllParticipating();
                        let detailMsg = `⚖️| *RESULTADO DA BUSCA:*\n\n`;
                        let mnts = [];

                        for (const gid in allGroups) {
                            const group = allGroups[gid];
                            for (const eb of embargados) {
                                const isPresent = group.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(eb.jid));
                                if (isPresent) {
                                    detailMsg += `- Embargado: @${cleanID(eb.jid)}\n- Grupo: ${group.subject}\n\n`;
                                    mnts.push(eb.jid);
                                }
                            }
                        }
                        if (mnts.length === 0) return sock.sendMessage(jid, { text: '⚖️| Nenhum infiltrado encontrado.' });
                        return await sock.sendMessage(jid, { text: detailMsg, mentions: mnts });
                    }

                    // --- AÇÃO PADRÃO: CONSULTAR ---
                    const finalTarget = target || cleanSender;
                    tUser = await getUser(finalTarget);
                    if (!tUser.embargo || !tUser.embargo.active) return sock.sendMessage(jid, { text: '⚖️| Usuário limpo.' });

                    return sock.sendMessage(jid, { text: `⚖️ @${cleanID(finalTarget)} está EMBARGADO.\nMotivo: ${tUser.embargo.reason}`, mentions: [finalTarget] });
                }
                // ============================================================
                // 🚫 SISTEMA DE AUTOBAN (LOCAL / COMUNIDADE)
                // ============================================================
                if (command === '!autoban') {
                    if (!isMaster) return;
                // 🚫 SISTEMA DE AUTOBAN
                // ===================================
                if (command === '!autoban') {
                    if (!isMaster) return;
                    const target = getTarget(); // Nova função.

                    // --- 1. ADD AUTOBAN ---
                    if (sub === 'add') {
                        const params = argText.replace('add', '').split('|').map(a => a.trim());
                        const targetJid = getTarget();
                        if (!targetJid || !params[1]) return sock.sendMessage(jid, { text: '❌ Use: !autoban add @user | motivo | link(opcional)' });

                        const reason = params[1];
                        const link = params[2] || 'Sem link';

                        await GroupConfig.findOneAndUpdate({ jid }, {
                            $push: { autoBanList: { jid: targetJid, reason, link, admin: user.name, date: new Date() } }
                        }, { upsert: true });

                        await sock.sendMessage(jid, { text: `📕| @${cleanID(targetJid)} foi adicionado a lista de auto ban do ${locType}!\n\n*Motivo:* ${reason}\n*Link:* ${link}`, mentions: [targetJid] });

                        // Mensagem PV
                        const msgPV = `📜| *INFORME ACADEMY*\n> Envio: ${moment().format('DD/MM/YY • HH:mm')}\n\nOlá @${cleanID(targetJid)}.\n\nVenho informar que você foi incluído na lista de auto banimento do ${locType} *${locName}*, por decisão de ${user.name}, pelo seguinte motivo:\n\n${reason}\n\nCaso entenda que a medida foi um equívoco, recorra em: analise@mail.acdm`;
                        await sock.sendMessage(targetJid, { text: msgPV, mentions: [targetJid] });

                        if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [targetJid], 'remove');
                        return;
                    }

                    // --- 2. LISTAR ---
                    if (sub === 'list') {
                        let res = `📕| *LISTA DE AUTO BAN*\n> ${locName}\n> Em: ${moment().format('DD/MM/YY • HH:mm')}\n\n`;
                        gConf.autoBanList.forEach(b => {
                            res += `🔒| @${cleanID(b.jid)}\n> ╰> Por: ${b.admin}\n> ╰> Em: ${moment(b.date).format('DD/MM/YY')}\n`;
                        });
                        return sock.sendMessage(jid, { text: res, mentions: gConf.autoBanList.map(b => b.jid) });
                    }

                    // --- 3. REMOVER AUTOBAN (REAVALIAÇÃO) ---
                    if (sub === 'rmv') {
                        if (!isMaster) return;

                        const targetJid = getT
                        if (!targetJid) return sock.sendMessage(jid, { text: '❌ Mencione o usuário ou digite o número para remover do AutoBan.' });

                        // Remove do array no MongoDB
                        const result = await GroupConfig.findOneAndUpdate(
                            { jid },
                            { $pull: { autoBanList: { jid: targetJid } } },
                            { new: true }
                        );

                        // SMS no Grupo
                        await sock.sendMessage(jid, {
                            text: `📗| @${cleanID(targetJid)} foi removido da lista de autoban!`,
                            mentions: [targetJid]
                        });

                        // SMS NO PV (Formal)
                        const msgPV = `📜| *INFORME ACADEMY*\n> Envio: ${moment().format('DD/MM/YY • HH:mm')}\n\nOlá @${cleanID(targetJid)}.\n\nVenho por meio deste informar que, após reavaliação administrativa, seu nome foi removido da lista de auto banimento do ${locType} *${locName}*.\n\nA presente decisão passa a ter efeito imediato, mantendo-se válidas as regras e normas do ${locType} *${locName}*, às quais todos os membros estão sujeitos.\n\n———\nAtenciosamente, Diretoria Academy 💜`;

                        await sock.sendMessage(targetJid, { text: msgPV, mentions: [targetJid] });
                        return;
                    }

                    if (sub === 'busq') {
                        if (!isMaster) return;

                        const gConf = await GroupConfig.findOne({ jid });
                        const locName = gConf?.communityName || groupName;

                        // Pega a lista de autoban (se for comunidade, pega de todos os grupos da comuna)
                        let blackList = [];
                        if (gConf?.communityName) {
                            const groupsInComm = await GroupConfig.find({ communityName: gConf.communityName });
                            blackList = groupsInComm.flatMap(g => g.autoBanList);
                        } else {
                            blackList = gConf?.autoBanList || [];
                        }

                        const metadata = await sock.groupMetadata(jid);
                        let foundLogs = [];
                        let mentions = [];

                        blackList.forEach(banned => {
                            const isPresent = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(banned.jid));
                            if (isPresent) {
                                foundLogs.push({
                                    jid: banned.jid,
                                    reason: banned.reason,
                                    admin: banned.admin,
                                    date: banned.date
                                });
                                mentions.push(banned.jid);
                            }
                        });

                        // SMS 1: Resumo
                        await sock.sendMessage(jid, { text: `A busca resultou em *${foundLogs.length}* infratores no grupo/comunidade *${locName}*!` });

                        // SMS 2: Detalhes
                        if (foundLogs.length > 0) {
                            let detailMsg = `🔒| *INFRATORES DETECTADOS:*\n\n`;
                            foundLogs.forEach(log => {
                                detailMsg += `🔒| @${cleanID(log.jid)}\n> Ocorrência: ${moment(log.date).format('DD/MM/YY HH:mm')}\n> Motivo: ${log.reason}\n> Por: ${log.admin}\n\n`;
                            });
                            await sock.sendMessage(jid, { text: detailMsg, mentions: mentions });
                        } else {
                            await sock.sendMessage(jid, { text: `📕| Nenhum registro de auto ban encontrado para este usuário na rede Academy!` });
                        }
                        return;
                    }

                    // --- 3. CHECK STATUS ---
                    const targetJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || cleanSender;
                    const banData = gConf.autoBanList.find(b => b.jid === targetJid);

                    if (!banData) return sock.sendMessage(jid, { text: '📕| Nenhum registro encontrado para este usuário!' });

                    let res = `📕| @${cleanID(targetJid)} está na lista de auto ban do ${locType} *${locName}*!\n\n🔒| @${cleanID(targetJid)}\n> Ocorrência: ${moment(banData.date).format('DD/MM/YY • HH:mm')}\n\n*Motivo:* ${banData.reason}\n*Link:* ${banData.link}\n*Por:* ${banData.admin}`;
                    return sock.sendMessage(jid, { text: res, mentions: [targetJid] });
                }

                // ============================================================
                // 📨 ACADEMY MAIL SYSTEM (RECONSTRUÍDO)
                // ============================================================

                // --- 🍻 CADASTRO DE USUÁRIO (Para to
                // 📨 ACADEMY MAIL SYSTEM
                // ===================================

                // --- 🍻 CADASTRO DE USUÁRIO🍻| Registro concluído! Você agora possui autorização para utilizar o sistema de Mail Academy.' });
                }

                // --- 🍻 CADASTRO DE NICK DO GRUPO ---
                if (command === '!cadastrargp') {
                    if (!isAdmin && !isMaster) return;
                    const nick = args[0]?.toLowerCase();
                    const desc = argText.replace(args[0], '').trim();
                    if (!nick) return sock.sendMessage(jid, { text: '❌ Use: !cadastrargp <nick> | <descrição>' });

                    await GroupConfig.findOneAndUpdate(
                        { jid },
                        { nick, description: desc, mailRegistered: true },
                        { upsert: true }
                    );
                    return sock.sendMessage(jid, { text: `✅| Este grupo foi registrado no sistema como: *${nick}*` });
                }

                // --- 💜 LISTAGEM DE GRUPOS CADASTRADOS (Diretores) ---
                if (command === '!listgp') {
                    if (!isMaster && !isDev) return;
                    const gps = await GroupConfig.find({ mailRegistered: true });
                    let res = `💜| *LISTA DE ;
                    gps.forEach(g => {
                        res += `🏛️ *${g.nick}* | ${g.description || 'Sem descrição'}\n> 📅 Desde: ${moment(g.createdAt).format('DD/MM/YYYY')}\n\n`;
                    });
                    return sock.sendMessage(jid, { text: res });
                }

                // --- 💜 CRIAR LISTA DE MAIL ---
                if (command === '!criarlistmail') {
                    if (!isMaster && !isDev) return;
                    const listName = args[0]?.toLowerCase();
                    if (!listName) return;

                    const exists = user.mailLists.find(l => l.name === listName);
                    if (exists) return sock.sendMessage(jid, { text: '❌ Essa lista já existe.' });

                    user.mailLists.push({ name: listName, targets: [] });
                    await user.save();
                    return sock.sendMessage(jid, { text: `💜| Lista de transmissão *${listName}* criada com sucesso.` });
                }

                // --- 💜 ADICIONAR À LISTA ---
                if (command === '!addmail') {
                    if (!isMaster || args[0] !== 'list') return;
                    // Ex: !addmail list Afiliados | NickGP / +55...
                    const params = argText.replace('list', '').split('|').map(a => a.trim());
                    const listName = params[0]?.toLowerCase();
                    const targets = params[1]?.split('/').map(t => t.trim());

                    const listIdx = user.mailLists.findIndex(l => l.name === listName);
                    if (listIdx === -1) return sock.sendMessage(jid, { text: '❌ Lista não encontrada.' });

                    targets.forEach(t => {
                        let formatted = t.includes('@') ? t : (t.startsWith('+') ? t.replace(/\D/g, '') + '@s.whatsapp.net' : t.toLowerCase());
                        if (!user.mailLists[listIdx].targets.includes(formatted)) {
                            user.mailLists[listIdx].targets.push(formatted);
                        }
                    });

                    await user.save();
                    return sock.sendMessage(jid, { text: `✅| Destinatários adicionados à lista *${listName}*.` });
                }

                // --- ✉️ COMANDO !MAIL (O CORAÇÃO DO SISTEMA) ---
                if (command === '!mail') {
                    // 1. Verificação de Cadastro
                    if (!user.isMailRegistered && !isDev) {
                        return sock.send| Acesso Negado. Você precisa estar cadastrado no sistema (!cadastrarmail).' });
                    }

                    // 2. Parsing dos Argumentos: !mail Destino Titulo | Mensagem
                    const parts = argText.split('|').map(p => p.trim());
                    if (parts.length < 2) return sock.sendMessage(jid, { text: '❌ Formato: !mail <destino> <titulo> | <mensagem>' });

                    const firstPart = parts[0].split(' ');
                    const destination = firstPart[0].toLowerCase();
                    const title = firstPart.slice(1).join(' ');
                    const body = parts[1];

                    // 3. Captura de Mídia (Anexo)
                    const media = await downloadMedia(msg); // Função que já criamos antes

                    // 4. Resolução de Destinatários
                    let finalTargets = [];
                    let isGlobal = false;

                    if (destination === 'diretoria') {
                        if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Apenas Masters enviam mail à Diretoria.' });
                        finalTargets.push(ID_GRUPO_DIRETORIA);
                    }
                    else if (destination === 'denuncia' || destination === 'denúncia') {
                        finalTargets.push(ID_GRUPO_DENUNCIAS);
                    }
                    else if (destination === 'global') {
                        if (!isDev) return;
                        isGlobal = true;
                        const allGps = await GroupConfig.find({ mailRegistered: true });
                        finalTargets = allGps.map(g => g.jid);
                    }
                    else if (destination.startsWith('+') || destination.includes('@')) {
                        // Por número ou menção (usando getTarget adaptado)
                        const targetNum = destination.startsWith('+') ? destination.replace(/\D/g, '') + '@s.whatsapp.net' : getTarget();
                        if (targetNum) finalTargets.push(targetNum);
                    }
                    else {
                        // Tenta Nick de Grupo ou Lista
                        const gp = await GroupConfig.findOne({ nick: destination });
                        if (gp) {
                            if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas Diretores enviam mail para grupos específicos.' });
                            finalTargets.push(gp.jid);
                        } else {
                            const list = user.mailLists.find(l => l.name === destination);
                            if (list) {
                                if (!isDev) return;
                                // Resolve nicks dentro da lista
                                for (const t of list.targets) {
                                    if (t.endsWith('@g.us') || t.endsWith('@s.whatsapp.net')) finalTargets.push(t);
                                    else {
                                        const subGp = await GroupConfig.findOne({ nick: t });
                                        if (subGp) finalTargets.push(subGp.jid);
                                    }
                                }
                            }
                        }
                    }

                    if (finalTargets.length === 0) return sock.sendMessage(jid, { text: '❌ Destino não identificado.' });

                    // 5. Função de Envio com Delay (Anti-Ban)
                    await sock.sendMessage(jid, { text: `🚀| Processando envio de Mail para ${finalTargets.length} destinatário(s)...` });

                    for (const target of finalTargets) {
                        const formattedMsg = `📨 *MAIL ACADEMY SYSTEM*\n\n*Assunto:* ${title}\n*De:* ${user.name} (${user.rank})\n\n${body}\n\n_Procedimento Institucional Academy_ 🏛️`;

                        try {
                            if (media) {
                                const mediaType = media.type === 'sticker' ? 'image' : media.type; // Converte sticker pra imagem se necessário
                                await sock.sendMessage(target, { [mediaType]: media.buffer, caption: formattedMsg });
                            } else {
                                await sock.sendMessage(target, { text: formattedMsg });
                            }

                            // Lógica especial para Denúncia (Cópia do título para diretoria)
                            if (destination === 'denuncia') {
                                await sock.sendMessage(ID_GRUPO_DIRETORIA, { text: `🔔| *NOVA DENÚNCIA RECEBIDA*\nAssunto: ${title}\nRelator: @${cleanID(cleanSender)}`, mentions: [cleanSender] });
                            }
                        } catch (e) {
                            console.log(`Erro ao enviar mail para ${target}`);
                        }
                        await delay(3000); // 3 segundos entre envios
                    }

                    return sock.sendMessage(jid, { text: '✅| Sistema de Mail: Transmissão concluída com sucesso.' });
                }

                // --- 💜 LISTAGEM DE USUÁRIOS CADASTRADOS (Diretores/Masters) ---
                if (command === '!listmailusers' || command === '!listusuariosmail') {
                    if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Acesso restrito a Masters e DEVS.' });

                    const users = await UserProue });

                    if (users.length === 0) {
                        return sock.sendMessage(jid, { text: '📨| Não há usuários cadastrados no sistema de mail no momento.' });
                    }

                    let report = `💜| *USUÁRIOS AUTORIZADOS - MAIL ACADEMY*\n`;
                    report += `> Total de Remetentes: ${users.length}\n\n`;

                    users.forEach((u, index) => {
                        report += `${index + 1}. 👤 *${u.name}*\n`;
                        report += `> ID: @${cleanID(u.jid)}\n`;
                        report += `> Rank: ${u.rank}\n\n`;
                    });

                    report += `_Para revogar acessos, use o banco de dados._ 🏛️`;

                    return sock.sendMessage(jid, {
                        text: report,
                        mentions: users.map(u => u.jid)
                    });
                }

                // ============================
                // 👑 DIRETORIA & RELATÓRIOS
                // ============================
                if (command === '!userg') {
                    const targetJid = msg.messa=======
                // 👑 DIRETORIA & RELATÓRIOS
                // =======
                    let report = `│✦.̇𖥨֗Nome: ${tUser.name}\n🔖 wa.me/${tUser.phoneNumber}\n> ${tUser.bio}\n\n*│✦.̇𖥨֗GRUPOS ATIVOS*\n`;
                    tUser.activeGroups.forEach(g => {
                        report += `☀️ ${g.groupName}\n> ╰> ${g.role} • ${g.msgCount} msgs\n`;
                    });

                    report += `\n*│✦.̇𖥨֗ADVERTÊNCIAS GLOBAIS*\n`;
                    if (tUser.globalWarnings.length === 0) report += "> Nenhuma.\n";
                    tUser.globalWarnings.forEach(w => report += `🔴 ${w.reason} (${w.duration})\n`);

                    let pfp; try { pfp = await sock.profilePictureUrl(targetJid, 'image'); } catch { pfp = 'https://i.imgur.com/62j1H2p.png'; }

                    await sock.sendMessage(jid, { image: { url: pfp }, caption: report, mentions: [targetJid] });
                    return;
                }

                if (command === '!globalusers') {
                    if (!isDev) return;

                    // Busca até 50 usuários com atividade
                    const users = await UserProfile.find({ 'activeGroups.0': { $exists: true } }).limit(50);

                    let txt = "💜 *!GLOBALUSERS REPORT*\n";
                    txt += `> Total listado: ${users.length}\n\n`;

                    // Array para guardar os JIDs que serão mencionados
                    let mentions = [];

                    users.forEach(u => {
                        const idNum = cleanID(u.jid); // Pega apenas os números

                        // No texto, usamos @ + numero para o zap reconhecer o link
                        txt += `👤 @${idNum}\n`;

                        // Adicionamos o JID real na lista de menções
                        mentions.push(u.jid);

                        // Lista os grupos daquele usuário
                        u.activeGroups.forEach(g => {
                            txt += `> ╰> ${g.groupName} • ${g.msgCount} msgs\n`;
                        });
                        txt += "\n";
                    });

                    txt += `_Diretoria Academy System_ 🏛️`;

                    // Enviamos a mensagem com a lista de menções
                    await sock.sendMessage(jid, {
                        text: txt,
                        mentions: mentions
                    }, { quoted: msg });

                    return;
                }

                if (command === '!filtrog') {
                    if (!isDev) return;

                    // 1. Definição do Filtro
                    const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    const filterText = argText.trim();

                    if (!filterText && !mentionedJid) {
                        return sock.sendMessage(jid, { text: '🔎 Use: !filtrog <Nome/@User>, <Nome do Grupo> ou <Quantidade SMS>' });
                    }

                    let users = [];
                    let searchMode = ''; // 'USER' (Full) ou 'FILTER' (Parcial)

                    // 2. Lógica de Busca no Banco de Dados

                    // CASO A: Menção (@User)ou 'FILTER'

                    // 2. Lógica de Busca no Banco

                    // CASO A: Menção (@User)
                    if (mentionedJid) {
                        searchMode = 'USER';
                        users = await UserProfile.find({ jid: mentionedJid });
                    }
                    // CASO B: Busca por Quantidade
                    else if (/^\d+$/.test(filterText)) {
                        searchMode = 'FILTER';
                        const minMsgs = parseInt(filterText);
                        // Busca quem tem pelo menos um grupo com mais mensagens que o solicitado
                        users = await UserProfile.find({ "activeGroups.msgCount": { $gt: minMsgs } })
                            .sort({ "activeGroups.msgCount": -1 }) // Ordena do maior para o menor
                            .limit(20);
                    }
                    // CASO C: Busca Textual
                    else {
                        const cleanNum = filterText.replace(/\D/g, ''); // Remove símbolos para buscar no telefone

                        // Primeiro tenta buscar se é um USUÁRIO (pelo nome, jid ou telefone)
                        const userQuery = [
                            { name: { $regex: filterText, $options: 'i' } },
                            { jid: { $regex: filterText, $options: 'i' } }
                        ];
                        if (cleanNum.length > 6) userQuery.push({ phoneNumber: { $regex: cleanNum } });

                        const userResults = await UserProfile.find({ $or: userQuery }).limit(10);

                        if (userResults.length > 0) {
                            searchMode = 'USER'; // Encontrou pelo nome/número
                            users = userResults;
                        } else {
                            // Se não achou usuário, busca por NOME DE GRUPO
                            const groupResults = await UserProfile.find({
                                'activeGroups.groupName': { $regex: filterText, $options: 'i' }
                            }).limit(20);
                            
                            if (groupResults.length > 0) {
                                searchMode = 'FILTER'; // Encontrou pelo

                    if (users.length === 0) {
                        return sock.sendMessage(jid, { text: `🔎 Nenhum resultado encontrado para: "${filterText}"` });
                    }

                    // 3. Montagem da Resposta (Formatação Visual Estrita)
                    let response = "";
                    let mentions = [];

                    // Cabeçalho bonito
                    const header = searchMode === 'USER' ? 'RELATÓRIO GLOBAL' : `FILTRO: "${filterText}"`;
                    response += `🔎 *${header}*\n•\n`;

                    for (const u of users) {
                        const cleanId = cleanID(u.jid); // Função auxiliar para pegar só o número
                        mentions.push(u.jid);

                        // Cabeçalho do Usuário
                        // Ex: @Isaac Xuxu Doce
                        response += `@${cleanId} ${u.name}\n`;

                        // --- FORMATAÇÃO DE ADVS GLOBAIS ---
                        // Só mostra se tiver e se for busca de Usuário (Full)
                        if (u.globalWarnings.length > 0 && searchMode === 'USER') {
                            const count = String(u.globalWarnings.length).padStart(2, '0'); // Transforma 1 em "01"
                            response += `> ╰> ${count} Adv Global\n`;
                        }
                        if (u.globalWarnings.length > 0 && searchMode === 'USER') {
                            const count = String(u.globalWarnings.length).padStart(2, '0');
                            response += `> ╰> ${count} Adv Global\n`;
                        }

                        // --- FORMATAÇÃO DOS GRUPOS E ADVS LOCAIS ---
                        // Ordena grupos por mensagem
                            let showThisGroup = false;

                            // DECISÃO: Mostrar ou não este grupo?
                            if (searchMode === 'USER') {
                                showThisGroup = true; // Mostra tudo
                            } else if (searchMode === 'FILTER') {
                                // Se for filtro numérico
                                if (/^\d+$/.test(filterText)) {
                                    if (g.msgCount > parseInt(filterText)) showThisGroup = true;
                                }
                                // Se for filtro de nome de grupo
                                else {
                                    if (g.groupName.toLowerCase().includes(filterText.toLowerCase())) showThisGroup = true;
                                }
                            }

                            if (showThisGroup) {
                                hasGroupShown = true;
                                
                                // Linha do Grupo: > Anellarium RPG • 320 sms
                                response += `> ${g.groupName} • ${g.msgCount} sms\n`;

                                // Checa se tem ADV neste grupo específico
                                // Filtra warnings onde o JID do grupo bate com o grupo atual do loop
                                const localAdvsCount = u.localWarnings.filter(w => w.groupJid === g.jid).length;

                                if (localAdvsCount > 0) {
                                    const countW = String(localAdvsCount).padStart(2, '0'); // "03"
                                    response += `> ╰> ${countW} Advertências\n`;
                                }
                            }
                        });

                        // Se não mostrou nenhum grupo (caso raro de user sem grupo ativo)
                        if (!hasGroupShown && searchMode === 'USER') {
                            response += `> (Sem registro de grupos ativos)\n`;
                        }
                        
                        response += `\n`; // Pula linha entre usuários
                    }

                    await sock.sendMessage(jid, { text: response, mentions: mentions });
                    return;
                }

                // ============================
                // 🛠️ UTILITÁRIOS
                // ============================

                if (command === '!sticker') {=======
                // 🛠️ UTILITÁRIOS
                // ======= if (!media) return sock.sendMessage(jid, { text: 'Envie uma mídia.' });
                    const sticker = new Sticker(media.buffer, {
                        pack: 'Academy', author: 'Bot', type: StickerTypes.FULL, quality: 50
                    });
                    await sock.sendMessage(jid, await sticker.toMessage());
                    return;
                }

                // Ping
                if (command === '!ping') {
                    return sock.sendMessage(jid, { text: `Latência: ${(Date.now() / 1000) - msgTimestamp}s` });
                }

                // ============================
                // 🆕 NOVOS COMANDOS ACADEMY
                // ============================

                // 👑 PROMOÇÃO: DEV (Apenas Don=======
                // 🆕 NOVOS COMANDOS ACADEMY
                // ===================================

                // 👑 PROMOÇÃO: DEV (.sendMessage(jid, { text: 'Marque o usuário.' });

                    await UserProfile.findOneAndUpdate({ jid: target }, { rank: 'Dev' });
                    return sock.sendMessage(jid, { text: `👑 @${cleanID(target)} foi promovido a **DEV**!`, mentions: [target] });
                }

                // 🛡️ PROMOÇÃO: MASTER (Apenas Devs)
                if (command === '!master') {
                    if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVs podem nomear Masters.' });
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return sdMessage(jid, { text: 'Marque o usuário.' });

                    await UserProfile.findOneAndUpdate({ jid: target }, { rank: 'Master' });
                    return sock.sendMessage(jid, { text: `🛡️ @${cleanID(target)} foi promovido a **MASTER**!`, mentions: [target] });
                }

                // ⚜️ CANONIZAR (Imunidade)
                if (command === '!canonizar') {
                    if (!isDev) return;
                    const sub = args[0]?.toLowerCase();
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return sock.sendMessage(jid, { text: 'Mencione o usuário.' });

                    const tUser = await getUser(target);

                    if (sub === 'rmv') {
                        tUser.isCanonized = false;
                        await tUser.save();
                        return sock.sendMessage(jid, { text: `💀 *DECRETO ACADEMY*\n\nO status de @${cleanID(target)} foi alterado para: *DESCANONIZADO*.\nJustificativa: Revogação de privilégios.\n\n_Status: Vulnerável_`, mentions: [target] });
                    } else {
                        tUser.isCanonized = true;
                        await tUser.save();
                        return sock.sendMessage(jid, { text: `📜 *DECRETO ACADEMY*\n\nO status de @${cleanID(target)} foi alterado para: *CANONIZADO*.\nJustificativa: Reconhecimento de mérito institucional.\n\n_Status: Imune a Penas e Expulsões_`, mentions: [target] });
                    }
                }

                // 🖼️ LINKIMG (Com Preview)
                if (command === '!linkimg') {
                    const media = await downloadMedia(msg);
                    if (!media || media.type !== 'image') return sock.sendMessage(jid, { text: 'Envie/Marque uma imagem.' });

                    await sock.sendMessage(jid, { text: '⏳ Gerando link...' });

                    cloudinary.uploader.upload_stream({ resource_type: 'image' }, async (err, result) => {
                        if (err) return sock.sendMessage(jid, { text: 'Erro no upload.' });

                        // Envia a imagem de volta COM o link na legenda (Gera o preview visual no zap)
                        await sock.sendMessage(jid, {
                            image: { url: result.secure_url },
                            caption: `🔗 *Link Gerado:*\n${result.secure_url}`
                        });
                    }).end(media.buffer);
                    return;
                }

                // --- COMANDO !ADDCARGO (Só Master/Dev) ---
                if (command === '!addcargo') {
                    if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Apenas Masters podem atribuir cargos.' });

                    const target = msg.mextMessage?.contextInfo?.mentionedJid?.[0];
                    // Pega o texto após a menção
                    const cargo = argText.replace(/@\d+/g, '').trim();

                    if (!target || !cargo) return sock.sendMessage(jid, { text: '❌ Use: !addcargo @usuario Padeiro' });

                    await UserProfile.findOneAndUpdate(
                        { jid: target },
                        { $push: { cargos: cargo } }
                    );

                    return sock.sendMessage(jid, { text: `✅ Cargo *"${cargo}"* atribuído a @${cleanID(target)}`, mentions: [target] });
                }

                // --- COMANDO !RMCARGO (Para limpar a lista se errar) ---
                if (command === '!rmcargo') {
                    if (!isMaster) return;
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return ❌ Marque o usuário.' }); // Adicionado aviso

                    await UserProfile.findOneAndUpdate({ jid: target }, { $set: { cargos: [] } });
                    return sock.sendMessage(jid, { text: `🗑️ Todos os cargos de @${cleanID(target)} foram removidos.`, mentions: [target] });
                }

                // --- COMANDO !RGPERFIL (Versão Títulos) ---
                if (command === '!rgperfil') {
                    // Tenta pegar o alvo (marcado ou por número digitado)
                    const target = getTarget() || cleanSender;
                    const tUser = await g---
                if (command === '!rgperfil') {
                    // Tenta pegar o alvo
                    try {
                        pfp = await sock.profilePictureUrl(target, 'image');
                    } catch {
                        pfp = 'https://i.imgur.com/62j1H2p.png'; // Fallback
                    }

                    // Gera o Buffer da imagem
                    const buffer = await generateRG(tUser, pfp);

                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: `📇 *IDENTIDADE ACADEMY OFICIAL*\n\nPropriedade de: *${tUser.name}*\nNível de Acesso: *${tUser.rank.toUpperCase()}*`,
                        mentions: [target]
                    }, { quoted: msg });
                    return;
                }
                if (command === '!bio') {
                    const newBio = argText;
                    if (!newBio) return sock.sendMessage(jid, { text: '📝 Escreva sua bio.\nEx: !bio Mestre de RPG.' });

                    user.bio = newBio;
                    await user.save();
                    return sock.sendMessage(jid, { text: '✅ Biografia atualizada!' });
                }

                if (command === '!background' || command === '!capa') {
                    const media = await downloadMedia(msg);
                    if (!media || media.type !== 'image') return sock.sendMessage(jid, { text: '🖼️ Envie uma imagem com a legenda !background' });

                    await sock.sendMessage(jid, { text: '⏳ Atualizando capa...' });

                    cloudinary.uploader.upload_stream({ resource_type: 'image' }, async (err, result) => {
                        if (err) return sock.sendMessage(jid, { text: 'Erro no upload.' });

                        user.backgroundUrl = result.secure_url;
                        await user.save();

                        await sock.sendMessage(jid, { text: '✅ Capa do Perfil definida com sucesso!\nUse !rgperfil para ver.' });
                    }).end(media.buffer);
                    return;
                }

            } catch (e) {
                console.error("Erro Fatal no Comando:", e);
                await sock.sendMessage(jid, { text: '❌ Erro interno ao processar comando.' });
            }
            // ============================================================
            // 🧩 SISTEMA DE COMUNIDADES ACADEMY
            // ============================================================

            if (command === '!comunidade' || command === '!comunidades') {
                const subCommand = args[0]?.toLowerCase();

                // --- 1. CRIAR COMUNIDADE ---
                if (subCommand === 'criar') {
                    if (!isMaster) return;
                    const params = argText.replace('criar', '').split('|').map(a => a.trim());
                    if (params.length < 2) return sock.sendMessage(jid, { text: '❌ Use: !comunidade criar Nome | Descrição (e reaja a uma imagem)' });

                    const media = await downloadMedia(msg); // Verifica se marcou imagem
                    let imgUrl = null;
                    if (media && media.type === 'image') {
                        const upload = await new Promise((resolve) => {
                            cloudinary.uploader.upload_stream({ resource_type: 'image' }, (err, res) => resolve(res)).end(media.buffer);
                        });
                        imgUrl = upload?.secure_url;
                    }

                    try {
                        await Community.create({ name: params[0], description: params[1], creatorJid: cleanSender, imageUrl: imgUrl });
                        return sock.sendMessage(jid, { text: `🧩| Comunidade *${params[0]}* foi criada!\n* Use !comunidade addgp para adicionar grupos.` });
                    } catch (e) { return sock.sendMessage(jid, { text: '❌ Nome de comunidade já existe.' }); }
                }

                // --- 2. ADICIONAR GRUPO ---
                if (subCommand === 'addgp') {
                    const commName = args[1];
                    const comm = await Community.findOne({ name: commName });
                    if (!comm) return sock.sendMessage(jid, { text: '❌ Comunidade não encontrada.' });
                    if (comm.creatorJid !== cleanSender && !isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas o criador da comunidade.' });

                    await Community.updateOne({ name: commName }, { $addToSet: { groups: jid } });
                    await GroupConfig.findOneAndUpdate({ jid }, { communityName: commName }, { upsert: true });

                    return sock.sendMessage(jid, { text: `🧩| O grupo *${groupName}* foi adicionado na comunidade *${commName}*!\n* Dados compartilhados com sucesso! 💜` });
                }

                // --- 3. REMOVER GRUPO ---
                if (subCommand === 'rmvgp') {
                    const gConf = await GroupConfig.findOne({ jid });
                    if (!gConf?.communityName) return sock.sendMessage(jid, { text: '❌ Este grupo não pertence a nenhuma comunidade.' });
                    if (!isAdmin && !isDev) return;

                    const commName = gConf.communityName;
                    await Community.updateOne({ name: commName }, { $pull: { groups: jid } });
                    await GroupConfig.updateOne({ jid }, { $set: { communityName: null } });

                    return sock.sendMessage(jid, { text: `🧩| O grupo *${groupName}* foi removido da comunidade *${commName}*! 💔` });
                }

                // --- 4. LISTAGEM GLOBAL (!comunidades) ---
                if (command === '!comunidades') {
                    if (!isMaster) return;
                    const comms = await Community.find();
                    let txt = `🧩| *COMUNIDADES GLOBAIS*\n> ${moment().format('DD/MM/YY • HH:mm')}\n\n`;
                    for (const c of comms) {
                        const stats = getCommunityStats(c);
                        txt += `* Comunidade: ${c.name}\n* Criada por: @${cleanID(c.creatorJid)}\n* Atividade Semanal: ${stats.currentWeek} msgs\n\n`;
                    }
                    return sock.sendMessage(jid, { text: txt, mentions: comms.map(c => c.creatorJid) });
                }

                // --- 5. DADOS DA COMUNIDADE (Status) ---
                const gConf = await GroupConfig.findOne({ jid });
                const searchName = args[0] || gConf?.communityName;
                if (!searchName) return sock.sendMessage(jid, { text: '❌ Especifique a comunidade ou adicione este grupo a uma.' });

                const comm = await Community.findOne({ name: searchName });
                if (!comm) return sock.sendMessage(jid, { text: '❌ Comunidade não encontrada.' });

                const stats = getCommunityStats(comm);
                const groupsData = await GroupConfig.find({ jid: { $in: comm.groups } });

                let report = `🧩| *COMUNIDADE ${comm.name.toUpperCase()}*\n`;
                report += `> Criada em: ${moment(comm.createdAt).format('DD/MM/YY HH:mm')}\n`;
                report += `> Por: ${comm.creatorJid === cleanSender ? 'Você' : '@' + cleanID(comm.creatorJid)}\n\n`;
                report += `☕| *DADOS GERAIS*\n* Grupos: ${comm.groups.length}\n* Msgs Semanais: ${stats.currentWeek}\n\n`;
                report += `🎲| *ATIVIDADE*\n* Semanal: ${stats.currentWeek}\n* Anterior: ${stats.lastWeek}\n\n`;
                report += `☕| *GRUPOS INTEGRANTES*\n`;
                groupsData.forEach(g => report += `• ${g.nick || 'Grupo sem Nick'}\n`);

                const opt = { caption: report, mentions: [comm.creatorJid] };
                if (comm.imageUrl) opt.image = { url: comm.imageUrl };
                return sock.sendMessage(jid, opt);
            }

            // --- CONFIGURAR ANTI-SPAM ---
            // Ex: !antispam config 5000 | 5 | s | local (Tempo ms | Msgs | Repetidas | Punição)
            if (command === '!antispam') {
                if (!isAdmin && !isMaster) return;
                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await GroupConfig.findOneAndUpdate({ jid }, { "antispam.enabled": sub === 'on' }, { upsert: true });
                    return sock.sendMessage(jid, { text: `🛡️| Anti-Spam ${sub === 'on' ? 'ATIVADO' : 'DESATIVADO'}.` });
                }

                if (sub === 'config') {
                    const params = argText.replace('config', '').split('|').map(a => a.trim());
                    if (params.length < 4) return sock.sendMessage(jid, { text: '❌ Use: !antispam config TempoMS | MaxMsgs | AntiRepeat(s/n) | Punicao(local/global/ban)' });

                    await GroupConfig.findOneAndUpdate({ jid }, {
                        antispam: {
                            enabled: true,
                            windowMs: parseInt(params[0]),
                            maxMsgs: parseInt(params[1]),
                            antiRepeat: params[2] === 's',
                            punishment: params[3]
                        }
                    }, { upsert: true });
                    return sock.sendMessage(jid, { text: '✅| Configuração Anti-Spam atualizada.' });
                }
            }

            // --- CONFIGURAR ANTI-STICKER ---
            // Ex: !antisticker config 3 | 10000 | ban (Limite | Tempo ms | Punicao)
            if (command === '!antisticker') {
                if (!isAdmin && !isMaster) return;
                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await GroupConfig.findOneAndUpdate({ jid }, { "antisticker.enabled": sub === 'on' }, { upsert: true });
                    return sock.sendMessage(jid, { text: `🖼️| Anti-Figurinha ${sub === 'on' ? 'ATIVADO' : 'DESATIVADO'}.` });
                }

                if (sub === 'config') {
                    const params = argText.replace('config', '').split('|').map(a => a.trim());
                    await GroupConfig.findOneAndUpdate({ jid }, {
                        antisticker: {
                            enabled: true,
                            limit: parseInt(params[0]),
                            windowMs: parseInt(params[1]),
                            punishment: params[2]
                        }
                    }, { upsert: true });
                    return sock.sendMessage(jid, { text: '✅| Configuração Anti-Figurinha atualizada.' });
                }
            }

            // ============================================================
            // 📖 GUIA COMPLETO DE OPERAÇÕES ACADEMY (V3.0 FINAL)
            // ============================================================
            if (command === '!comandos' || command === '!guia' || command === '!helpall') {
                const manualText = `🏛️ *MANUAL INTEGRAL ACADEMY SYSTEM v3.0* 🏛️\n\n` +
                    `⚖️ *SISTEMA PENAL & SEGURANÇA*\n` +
                    `• *!adv @user | motivo:* ADV Local/Comunitária (3 = Ban).\n` +
                    `• *!adv global @user | motivo | tempo:* ADV na Rede (5 = Embargo).\n` +
                    `• *!rmadv @user | local/global | ID:* Remove uma advertência.\n` +
                    `• *!listadv @user:* Lista ADVs locais/comunidade.\n` +
                    `• *!listaadv global @user:* Histórico penal completo.\n` +
                    `• *!kick @user:* Expulsão (Remove de toda a comunidade se houver).\n` +
                    `• *!autoban add @user | motivo:* Lista negra do setor.\n` +
                    `• *!autoban rmv @user:* Remove da lista negra.\n` +
                    `• *!autoban list:* Exibe os banidos do setor.\n` +
                    `• *!autoban busq:* Scanner de infratores presentes no grupo.\n` +
                    `• *!embargo @user:* Consulta status de banimento global.\n` +
                    `• *!embargo add @user | mot | tempo | link:* Banimento da Rede.\n` +
                    `• *!embargo rmv @user | tempo:* Reduz ou revoga embargo.\n` +
                    `• *!embargo list:* Lista todos os embargados da Academy.\n` +
                    `• *!embargo busq:* Scanner global de embargados infiltrados.\n\n` +
                    `👤 *PERFIL & IDENTIDADE (RG)*\n` +
                    `• *!rgperfil @user:* Gera RG Glassmorphism com Capa e Cargos.\n` +
                    `• *!bio [texto]:* Define sua biografia oficial.\n` +
                    `• *!background:* Define a imagem de capa do seu RG.\n` +
                    `• *!addcargo @user [nome]:* Atribui título/cargo ao perfil.\n` +
                    `• *!rmcargo @user:* Reseta todos os cargos do usuário.\n` +
                    `• *!userg @user:* Relatório técnico de atividade e grupos.\n\n` +
                    `🧩 *SISTEMA DE COMUNIDADES (SETORES)*\n` +
                    `• *!comunidade criar [nome] | [desc]:* Cria nova comunidade.\n` +
                    `• *!comunidade capa [nome]:* Altera a foto da comunidade.\n` +
                    `• *!comunidade addgp [nome]:* Vincula grupo à comunidade.\n` +
                    `• *!comunidade rmvgp [nome]:* Desvincula grupo da comunidade.\n` +
                    `• *!comunidade apagar [nome]:* Exclui a comunidade do sistema.\n` +
                    `• *!comunidade [nome]:* Status, Atividade e Grupos da Comuna.\n` +
                    `• *!comunidades:* Lista todas as comunidades e atividade semanal.\n\n` +
                    `🛡️ *SEGURANÇA AUTOMÁTICA (ANTI-FLOOD)*\n` +
                    `• *!bot [on/off]:* Ativa/Desativa as funções do bot no grupo.\n` +
                    `• *!antispam [on/off]:* Liga o filtro de mensagens rápidas.\n` +
                    `• *!antispam config [MS] | [Qtd] | [Repetir: s/n] | [Punição]:* Configura o rigor do filtro.\n` +
                    `• *!antisticker [on/off]:* Liga o filtro de figurinhas.\n` +
                    `• *!antisticker config [Qtd] | [MS] | [Punição]:* Configura o limite de stickers.\n\n` +
                    `📨 *SISTEMA DE MAIL (CORREIO)*\n` +
                    `• *!cadastrarmail:* Ativa permissão de envio de e-mails.\n` +
                    `• *!cadastrargp [nick] | [desc]:* Registra nick do grupo para receber mails (*Master/Dev*).\n` +
                    `• *!listgp:* Lista todos os grupos com nicks registrados.\n` +
                    `• *!criarlistmail [nome]:* Cria lista de transmissão pessoal.\n` +
                    `• *!addmail list [lista] | [alvos]:* Adiciona alvos à lista.\n` +
                    `• *!mail [dest] [assunto] | [msg]:* Envio formal (Suporta anexos).\n` +
                    `• *!listmailusers:* Lista todos os usuários autorizados a enviar mail.\n\n` +

                    `🧩 *COMANDOS NO-CODE (PAINEL WEB)*\n` +
                    `• Crie/edite comandos em *Painel → Comandos*.\n` +
                    `• Ações úteis: Texto, Reação, Delay, Imagem, Sticker, Variáveis, Webhook, Validar, Se/Então.\n` +
                    `• Webhook: habilite com *ALLOW_HTTP_ACTION=true* no .env.\n` +
                    `• Override (editar comando do sistema pelo painel): *ALLOW_RESERVED_OVERRIDE=true* + marcar “Substituir comando do sistema”.\n\n` +
                    `👑 *ADMINISTRAÇÃO & HIERARQUIA*\n` +
                    `• *!dev @user:* Nomeia Desenvolvedor (Dono).\n` +
                    `• *!master @user:* Nomeia Master (Moderador).\n` +
                    `• *!canonizar @user:* Atribui Imunidade (Imune a ADV/Ban).\n` +
                    `• *!canonizar rmv @user:* Remove Imunidade.\n\n` +
                    `🛠️ *UTILITÁRIOS GERAIS*\n` +
                    `• *!menu / !help:* Abre o menu dinâmico de categorias.\n` +
                    `• *!help add / !help del:* Gerencia comandos do menu.\n` +
                    `• *!sticker:* Cria figurinhas de imagem/vídeo.\n` +
                    `• *!linkimg:* Gera link com preview para imagens.\n` +
                    `• *!ping:* Checa latência.\n` +
                    `• *!globalusers:* Relatório de todos os usuários da rede.\n` +
                    `• *!filtrog [termo]:* Pesquisa usuários no banco de dados.\n\n` +
                    `_Academy System: Ordem e Excelência_ 💜🏛️⚜️`;

                let botPfp;
                try {
                    botPfp = await sock.profilePictureUrl(jidNormalizedUser(sock.user.id), 'image');
                } catch (e) {
                    botPfp = 'https://i.imgur.com/62j1H2p.png';
                }

                await sock.sendMessage(jid, {
                    image: { url: botPfp },
                    caption: manualText
                }, { quoted: msg });
                return;
            }

            // ============================================================
            // ⏫ FIM DOS COMANDOS ⏫
            // ============================================================

        } catch (e) {
            console.error("❌ ERRO NO HANDLER:", e);
        }
    });
    // ============================================================
    // 🚪 MONITOR DE ENTRADA (SEGURANÇA PROATIVA)
    // ============================================================
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update; // id = JID do grupo, participants = lista de quem entrou

        // Só agimos se a ação for 'add' (alguém entrou ou foi adicionado)
        if (action === 'add') {
            const gConf = await GroupConfig.findOne({ jid: id });

            // Verificação única: o bot precisa ser admin para expulsar
            let isBotAdmin = false;
            let groupName = 'Setor';
            try {
                const groupMetadata = await sock.groupMetadata(id);
                groupName = groupMetadata.subject || groupName;
                const botId = normalizeUserJid(sock.user.id);
                const botPart = groupMetadata.participants.find(p => normalizeUserJid(p.id) === botId);
                isBotAdmin = (botPart?.admin === 'admin' || botPart?.admin === 'superadmin');
            } catch (e) { }

            for (const jidUser of participants) {
                const cleanJid = normalizeUserJid(jidUser);
                const userNum = cleanID(cleanJid);

                // Garante que o usuário existe no banco (para embargo funcionar mesmo em novos)
                await getUser(cleanJid);

                if (!isBotAdmin) {
                    console.log(`⚠️ Infrator @${userNum} entrou, mas não sou admin para expulsar.`);
                    continue;
                }

                await enforceSecurityOnParticipant(id, groupName, gConf, cleanJid);
            }
        }
    });
}

// Inicia o sistema
startBot();
server.listen(PORT, () => console.log(`🚀 SERVIDOR WEB RODANDO NA PORTA ${PORT}`));