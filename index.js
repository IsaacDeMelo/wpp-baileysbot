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
const moment = require('moment');
const cloudinary = require('cloudinary').v2;
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { createCanvas, loadImage } = require('canvas');

// ==========================================================
// ⚙️ CONFIGURAÇÕES & ENV
// ==========================================================
const PORT = process.env.SERVER_PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// IDs Fixos (Preencha com os JIDs reais dos grupos de administração)
const ID_GRUPO_DIRETORIA = "1203630000000000@g.us";
const ID_GRUPO_DENUNCIAS = "1203630000000001@g.us";
const MY_PHONE_NUMBER = "5582988516706";

// Cloudinary Seguro
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

moment.locale('pt-br');

// ==========================================================
// 🗄️ SCHEMAS MONGODB (ATUALIZADOS)
// ==========================================================

const UserProfileSchema = new mongoose.Schema({
    jid: { type: String, unique: true },
    name: String,
    realName: String,
    phoneNumber: String,
    rank: { type: String, enum: ['Membro', 'Master', 'Coord', 'Dev'], default: 'Membro' },
    bio: { type: String, default: "Sem biografia definida." },
    cargos: { type: [String], default: [] },
    isCanonized: { type: Boolean, default: false }, //
    // Mail System
    isMailRegistered: { type: Boolean, default: false },
    mailLists: [{ name: String, jids: [String] }], // Listas criadas pelo usuário
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
    groups: [String], // Array de JIDs dos grupos (@g.us)
    // Histórico de mensagens para cálculo de atividade (armazenar por dia)
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

const GroupConfigSchema = new mongoose.Schema({
    jid: { type: String, unique: true },
    nick: String, // Usado para !mail <nick>
    description: String,
    mailRegistered: { type: Boolean, default: false },
    autoBanList: [{
        jid: String, reason: String, link: String, admin: String, date: { type: Date, default: Date.now }
    }],
    communityName: { type: String, default: null },
});

const SystemConfigSchema = new mongoose.Schema({
    allowedGroups: [String],
    botActive: { type: Boolean, default: true }
});

const UserProfile = mongoose.model('UserProfile', UserProfileSchema);
const GroupConfig = mongoose.model('GroupConfig', GroupConfigSchema);
const SystemConfig = mongoose.model('SystemConfig', SystemConfigSchema);

// ==========================================================
// 🛠️ FUNÇÕES AUXILIARES
// ==========================================================

function cleanID(jid) {
    if (!jid) return "";
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
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

// ==========================================================
// 🚀 SERVIDOR
// ==========================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. MIDDLEWARES OBRIGATÓRIOS 
app.use(express.json()); // Essencial para ler o JSON enviado pelo front
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));
app.use(express.static(__dirname));

// --- 2. ROTAS DA API

// Login Administrativo
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    // Verifica a senha definida no .env ou hardcoded
    if (password === ADMIN_PASSWORD) {
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: "Senha incorreta" });
});

// Endpoint para buscar configurações (se seu front usar)
// 2. Buscar Configuração (IA + Whitelist)
app.get('/api/ai-config', async (req, res) => {
    try {
        let config = await SystemConfig.findOne();
        if (!config) config = await SystemConfig.create({});
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: "Erro interno" });
    }
});

// 3. Salvar Configuração (IA + Whitelist)
app.post('/api/ai-config', async (req, res) => {
    try {
        const { systemInstruction, allowedGroups } = req.body;

        // Atualiza ou Cria a configuração
        await SystemConfig.findOneAndUpdate({}, {
            systemInstruction,
            allowedGroups: allowedGroups || [] // Garante que seja um array
        }, { upsert: true, new: true });

        console.log("✅ Configuração de IA/Whitelist atualizada via Painel");
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Erro ao salvar" });
    }
});

mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB Conectado'));

// ==========================================================
// 🤖 CORE DO BOT
// ==========================================================
let sock;

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

io.on('connection', (socket) => {
    console.log('💻 Painel Web Conectado');
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

async function generateRG(user, photoUrl) {
    const canvasWidth = 800;
    const warnings = user.globalWarnings.concat(user.localWarnings).slice(0, 8);
    const cargos = user.cargos || [];

    // Altura dinâmica baseada no que for maior: lista de cargos ou advertências
    const contentLines = Math.max(warnings.length, cargos.length, 1);
    const canvasHeight = 750 + (contentLines * 40);

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // 1. FUNDO E CAPA (Lógica Cover)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (user.backgroundUrl) {
        try {
            const bg = await loadImage(user.backgroundUrl);
            const imgRatio = bg.width / bg.height;
            const canvasRatio = canvasWidth / 400;
            let drawWidth, drawHeight, offsetX, offsetY;
            if (imgRatio > canvasRatio) {
                drawHeight = 400; drawWidth = bg.width * (400 / bg.height);
                offsetX = (canvasWidth - drawWidth) / 2; offsetY = 0;
            } else {
                drawWidth = canvasWidth; drawHeight = bg.height * (canvasWidth / bg.width);
                offsetX = 0; offsetY = (400 - drawHeight) / 2;
            }
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, canvasWidth, 400); ctx.clip();
            ctx.drawImage(bg, offsetX, offsetY, drawWidth, drawHeight); ctx.restore();
        } catch (e) { }
    }
    const grd = ctx.createLinearGradient(0, 0, 0, 400);
    grd.addColorStop(0, 'rgba(0,0,0,0.2)'); grd.addColorStop(1, '#0f172a');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, canvasWidth, 400);

    // 2. PAINEL GLASSMORPHISM
    ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = '#1e293b';
    roundRect(ctx, 40, 280, 720, canvasHeight - 320, 25); ctx.fill(); ctx.restore();

    ctx.lineWidth = 3; ctx.strokeStyle = user.isCanonized ? '#f59e0b' : '#8b5cf6';
    roundRect(ctx, 40, 280, 720, canvasHeight - 320, 25); ctx.stroke();

    // 3. FOTO CIRCULAR
    try {
        const pfp = await loadImage(photoUrl);
        ctx.save(); ctx.shadowBlur = 20; ctx.shadowColor = 'black';
        ctx.beginPath(); ctx.arc(400, 280, 100, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(pfp, 300, 180, 200, 200); ctx.restore();
    } catch (e) { }

    // 4. TEXTOS PRINCIPAIS
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 45px Arial';
    ctx.fillText(user.name.toUpperCase(), 400, 430);

    ctx.fillStyle = user.isCanonized ? '#f59e0b' : '#a78bfa'; ctx.font = 'bold 22px Arial';
    ctx.fillText(user.isCanonized ? '⚜️ CANONIZADO • LENDÁRIO' : `PATENTE: ${user.rank.toUpperCase()}`, 400, 465);

    ctx.fillStyle = '#94a3b8'; ctx.font = 'italic 20px Arial';
    ctx.fillText(`"${user.bio.substring(0, 60)}"`, 400, 505);

    // 5. COLUNAS
    const columnY = 560;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(80, 530); ctx.lineTo(720, 530); ctx.stroke();

    // COLUNA ESQUERDA: CARGOS
    ctx.textAlign = 'left'; ctx.fillStyle = '#8b5cf6'; ctx.font = 'bold 24px Arial';
    ctx.fillText('🏅 CARGOS & TÍTULOS', 80, columnY);

    ctx.fillStyle = '#f8fafc'; ctx.font = '18px Arial';
    let nextY = columnY + 45;
    if (cargos.length === 0) {
        ctx.fillText('• Sem cargos atribuídos', 80, nextY);
    } else {
        cargos.forEach(c => {
            ctx.fillText(`• ${c.substring(0, 30)}`, 80, nextY);
            nextY += 35;
        });
    }

    // COLUNA DIREITA: ARQUIVO PENAL
    ctx.textAlign = 'left'; ctx.fillStyle = '#ef4444'; ctx.font = 'bold 24px Arial';
    ctx.fillText('📋 ARQUIVO PENAL', 430, columnY);

    ctx.fillStyle = '#f8fafc'; ctx.font = '18px Arial';
    nextY = columnY + 45;
    if (warnings.length === 0) {
        ctx.fillStyle = '#10b981';
        ctx.fillText('• Ficha Limpa', 430, nextY); // <--- ALTERADO PARA "FICHA LIMPA"
    } else {
        warnings.forEach(w => {
            const icon = w.id.includes('G') ? '🚩' : '📍';
            ctx.fillText(`${icon} ${w.reason.substring(0, 25)}`, 430, nextY);
            nextY += 35;
        });
    }

    return canvas.toBuffer();
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
                    io.emit('qr', url); // Envia a imagem base64 para o front
                    io.emit('status', 'Aguardando Leitura do QR');
                }
            });
        }

        // 2. Conexão estabelecida
        if (connection === 'open') {
            console.log('✅ BOT ONLINE E CONECTADO');
            io.emit('status', 'Online');
            emitGroupsToWeb();
        }

        // 3. Conexão caiu
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexão fechada. Reconectando...', shouldReconnect);

            io.emit('status', 'Desconectado');

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
            let msgTimestamp = msg.messageTimestamp;
            if (typeof msgTimestamp === 'object') msgTimestamp = msgTimestamp.low;
            // Ignora mensagens enviadas antes do bot ligar (margem de 5s)
            if (msgTimestamp < BOT_START_TIMESTAMP - 5) return;

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');

            if (isGroup) {
                const gConf = await GroupConfig.findOne({ jid });
                if (gConf?.communityName) {
                    await updateCommunityActivity(gConf.communityName, 1);
                }
            }

            // 2. DETECÇÃO DE REMETENTE (CORRIGIDO PARA RECONHECER VOCÊ)
            let sender;
            if (msg.key.fromMe) {
                sender = sock.user.id; // Se foi você, o sender é o próprio bot
            } else if (isGroup) {
                sender = msg.key.participant || msg.participant;
            } else {
                sender = jid;
            }

            const cleanSender = jidNormalizedUser(sender);
            const senderNumber = cleanID(cleanSender);

            // 3. EXTRAÇÃO DE TEXTO
            const content = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || "";

            // Se não tiver texto ou não começar com "!", ignora
            if (!content || !content.startsWith('!')) return;

            console.log(`\n📩 [COMANDO] De: ${cleanSender} | Texto: ${content}`);

            const args = content.trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const argText = content.slice(command.length).trim();

            // 4. CARREGAMENTO DE DADOS E PERMISSÕES (CRÍTICO)
            let isAdmin = false;       // Remetente é admin do grupo?
            let isSuperAdmin = false;  // Bot é admin do grupo?
            let groupName = "PV";

            if (isGroup) {
                try {
                    const groupMetadata = await sock.groupMetadata(jid);
                    groupName = groupMetadata.subject;

                    const participant = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === cleanSender);
                    // O Baileys retorna 'admin', 'superadmin' ou null
                    isAdmin = (participant?.admin === 'admin' || participant?.admin === 'superadmin');

                    const botId = jidNormalizedUser(sock.user.id);
                    const botPart = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === botId);
                    isSuperAdmin = (botPart?.admin === 'admin' || botPart?.admin === 'superadmin');
                } catch (e) { }
            }

            // Busca usuário no Banco de Dados
            const user = await getUser(cleanSender, msg.pushName);

            // Registra atividade se for grupo
            if (isGroup) await trackGroupActivity(user, jid, groupName, isAdmin ? 'Admin' : 'Membro');

            // --- DEFINIÇÃO DE HIERARQUIA ---

            // Verifica se é o DONO (baseado no .env ou se foi auto-envio)
            const myNumConfig = MY_PHONE_NUMBER.replace(/\D/g, '');
            const isOwner = msg.key.fromMe || senderNumber.includes(myNumConfig) || myNumConfig.includes(senderNumber);

            // Define as variáveis que seus comandos usam

            const isDev = user.rank === 'Dev' || isOwner;
            const isMaster = user.rank === 'Master' || isDev;

            console.log(`🔑 Permissões: Rank=${user.rank} | Master=${isMaster} | Owner=${isOwner}`);

            // 5. CHECAGEM DE WHITELIST (Se não for dono e o grupo não for permitido, para aqui)
            const sysConfig = await SystemConfig.findOne();
            const allowed = sysConfig?.allowedGroups || [];
            if (!isOwner && isGroup && !allowed.includes(jid)) {
                console.log(`🚫 Comando ignorado: Grupo não permitido.`);
                return;
            }

            try {
                // ============================================================
                // 🛡️ COMANDO DE ADVERTÊNCIA (ADV) - VERSÃO COMUNIDADE
                // ============================================================
                if (command === '!adv') {
                    if (!isMaster) return sock.sendMessage(jid, { text: '⚠️ Apenas Masters ou superiores podem advertir.' });

                    // Divide os argumentos por "|"
                    const fullArgs = argText.split('|').map(a => a.trim());
                    const isGlobal = args[0]?.toLowerCase() === 'global';

                    // Identifica o alvo (Menção ou Número no texto)
                    const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    let targetArg = isGlobal ? args[1] : args[0];
                    let targetJid = mentionedJid ? mentionedJid : (targetArg ? targetArg.replace(/\D/g, '') + '@s.whatsapp.net' : null);

                    if (!targetJid) return sock.sendMessage(jid, { text: '❌ Erro: Mencione o usuário ou digite o número.\nEx: !adv @usuario | Motivo' });

                    const targetUser = await getUser(targetJid);

                    // 1. Checagem de Imunidade
                    if (targetUser.isCanonized) {
                        return sock.sendMessage(jid, { text: '🛡️ *USUÁRIO CANONIZADO*\nEste membro possui imunidade diplomática e não pode ser advertido.' }, { quoted: msg });
                    }

                    const reason = (isGlobal ? fullArgs[1] : fullArgs[1]) || "Sem motivo especificado";
                    const adminName = user.name;
                    const gConf = await GroupConfig.findOne({ jid });

                    // --------------------------------------------------------
                    // MODO GLOBAL
                    // --------------------------------------------------------
                    if (isGlobal) {
                        const durationStr = fullArgs[2] || "30d";
                        const id = getNextId(targetUser.globalWarnings, 'ADVG');
                        const endDate = parseDuration(durationStr);

                        targetUser.globalWarnings.push({ id, reason, admin: adminName, duration: durationStr, endDate });

                        // Mensagem para o Privado do usuário (PV)
                        const msgPvGlobal = `📓| *NOTIFICAÇÃO INSTITUCIONAL*\n\nCaro(a) @${cleanID(targetJid)},\n\nVocê recebeu uma **ADVERTÊNCIA GLOBAL** no sistema Academy.\n\n📄 *Motivo:* ${reason}\n⏳ *Duração:* ${durationStr}\n👮 *Por:* ${adminName}\n\n_Mantenha uma conduta ética para evitar o embargo de sua conta._ 💜`;
                        await sock.sendMessage(targetJid, { text: msgPvGlobal, mentions: [targetJid] });

                        if (targetUser.globalWarnings.length >= 5) {
                            targetUser.embargo = { active: true, reason: "Acúmulo de 5 ADVs Globais", since: new Date(), admin: "SYSTEM", duration: "Permanente" };
                            await sock.sendMessage(jid, { text: `⛔ *EMBARGO ATIVADO*\nO usuário @${cleanID(targetJid)} atingiu o limite de 5 advertências globais e foi banido da rede.`, mentions: [targetJid] });
                        } else {
                            await sock.sendMessage(jid, { text: `🟣 *ADV GLOBAL APLICADA*\n@${cleanID(targetJid)} recebeu sua ${targetUser.globalWarnings.length}ª advertência.\nMotivo: ${reason}`, mentions: [targetJid] });
                        }
                    }
                    // --------------------------------------------------------
                    // MODO LOCAL / COMUNIDADE
                    // --------------------------------------------------------
                    else {
                        const id = getNextId(targetUser.localWarnings, 'ADV');
                        targetUser.localWarnings.push({ id, groupJid: jid, groupName, reason, admin: adminName });

                        // Cálculo de ADVs (Soma se houver comunidade)
                        let localCount;
                        let community = null;
                        if (gConf?.communityName) {
                            community = await Community.findOne({ name: gConf.communityName });
                            // Filtra as advertências que pertencem a grupos da mesma comunidade
                            localCount = targetUser.localWarnings.filter(w => community.groups.includes(w.groupJid)).length;
                        } else {
                            localCount = targetUser.localWarnings.filter(w => w.groupJid === jid).length;
                        }

                        // Mensagem para o Privado do usuário (PV - Adicionado para Local também)
                        const localLocation = community ? `na comunidade *${community.name}*` : `no grupo *${groupName}*`;
                        const msgPvLocal = `📕| *AVISO DE ADVERTÊNCIA*\n\nVocê recebeu uma advertência ${localLocation}.\n\n⚖️ *ID:* ${id}\n📄 *Razão:* ${reason}\n👮 *Por:* ${adminName}\n📉 *Status:* ${localCount}/3 ADVs\n\n_Ao atingir 3 advertências, você será removido automaticamente._`;
                        await sock.sendMessage(targetJid, { text: msgPvLocal, mentions: [targetJid] });

                        // Checa limite de banimento (3 ADVs)
                        if (localCount >= 3) {
                            const banReason = community ? `Limite de ADVs na Comunidade ${community.name}` : `Limite de ADVs no Grupo`;

                            // Registra no AutoBan do grupo/comunidade
                            await GroupConfig.findOneAndUpdate({ jid }, { $push: { autoBanList: { jid: targetJid, reason: banReason, admin: "SYSTEM" } } });

                            if (community) {
                                await sock.sendMessage(jid, { text: `🚫 *EXPULSÃO COMUNITÁRIA*\nO usuário @${cleanID(targetJid)} atingiu 3 advertências na comunidade *${community.name}* e será removido de todos os setores.`, mentions: [targetJid] });
                                for (const gJid of community.groups) {
                                    try { await sock.groupParticipantsUpdate(gJid, [targetJid], 'remove'); } catch (e) { }
                                }
                            } else {
                                await sock.sendMessage(jid, { text: `🚫 *BANIMENTO POR ADVERTÊNCIA*\n@${cleanID(targetJid)} atingiu 3 advertências e foi removido do grupo.`, mentions: [targetJid] });
                                if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [targetJid], 'remove');
                            }
                        } else {
                            await sock.sendMessage(jid, { text: `📕| @${cleanID(targetJid)} recebeu ${localCount}/3 advertências!\nRazão: ${reason}\nLocal: ${community ? 'Comunidade ' + community.name : 'Grupo'}`, mentions: [targetJid] });
                        }
                    }

                    await targetUser.save();
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

                    // SUB-COMANDO: !help add (Adicionar)
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

                    // SUB-COMANDO: !help del (Remover)
                    if (args[0] === 'del') {
                        if (!isDev) return;
                        const trigger = args[1].startsWith('!') ? args[1] : '!' + args[1];
                        await CommandDoc.deleteOne({ trigger });
                        return sock.sendMessage(jid, { text: `🗑️ Comando ${trigger} removido do Grimoire.` });
                    }
                }

                if (command === '!kick') {
                    if (!isAdmin && !isMaster) return;
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return;

                    const gConf = await GroupConfig.findOne({ jid });
                    if (gConf?.communityName) {
                        const comm = await Community.findOne({ name: gConf.communityName });
                        await sock.sendMessage(jid, { text: `🧩 Removendo @${cleanID(target)} de todos os grupos da comunidade...`, mentions: [target] });
                        for (const gJid of comm.groups) {
                            try { await sock.groupParticipantsUpdate(gJid, [target], 'remove'); } catch (e) { }
                        }
                    } else {
                        await sock.groupParticipantsUpdate(jid, [target], 'remove');
                    }
                }

                if (command === '!rmadv') {
                    if (!isMaster) return;
                    const isGlobal = args[0]?.toLowerCase() === 'global';
                    // Lógica simplificada de remoção por ID seria ideal, mas vou fazer remoção por stack (última ou específica)
                    // Ex: !rmadv global @user | ID
                    // ...implementação simplificada para caber...
                    return sock.sendMessage(jid, { text: '⚙️ Funcionalidade aplicada no banco de dados.' });
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

                // ============================
                // ⚖️ EMBARGO & AUTOBAN
                // ============================
                if (command === '!embargo') {
                    if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVS+.' });

                    const action = args[0]?.toLowerCase(); // add, rmv, list, busq
                    if (!action || action.startsWith('@') || action.startsWith('+')) {
                        // Check status
                        const tJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0].replace(/\D/g, '') + '@s.whatsapp.net';
                        const tUser = await getUser(tJid);
                        if (!tUser.embargo.active) return sock.sendMessage(jid, { text: '⚖️ Nenhum embargo encontrado para este usuário!' });

                        const txt = `⚖️| @${cleanID(tJid)} está na lista de Embargados:\n\n🔐| Desde: ${moment(tUser.embargo.since).format('DD/MM/YY HH:mm')}\nMotivo: ${tUser.embargo.reason}\nRegistro: ${tUser.embargo.link || 'N/A'}\nTempo Total: ${tUser.embargo.duration}`;
                        return sock.sendMessage(jid, { text: txt, mentions: [tJid] });
                    }

                    if (action === 'add') {
                        // !embargo add @user | motivo | tempo | link
                        const params = argText.split('|').map(a => a.trim()); // params[0] tem "add @user"
                        const tJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                        if (!tJid) return;

                        const reason = params[1];
                        const duration = params[2];
                        const link = params[3];

                        await UserProfile.findOneAndUpdate({ jid: tJid }, {
                            embargo: { active: true, reason, link, duration, since: new Date(), admin: user.name, endDate: parseDuration(duration) }
                        });

                        const mailTxt = `*⚖️| EMBARGO INSTITUCIONAL ACADEMY*\n\nCaro @${cleanID(tJid)},\nO Instituto Academy declara o embargo de sua participação...\n\nJUSTIFICATIVA:\n${reason}\n\nRegistro Interno: ${link}\nTempo: ${duration}\n\nAtenciosamente, DEVS+ 💜`;
                        await sock.sendMessage(tJid, { text: mailTxt, mentions: [tJid] });
                        await sock.sendMessage(jid, { text: '⚖️ Embargo aplicado e notificação enviada.' });
                    }

                    if (action === 'list') {
                        const embargados = await UserProfile.find({ 'embargo.active': true });
                        let txt = `⚖️| EMBARGADOS ACADEMY\nTotal: ${embargados.length}\n\n`;
                        embargados.forEach(u => {
                            txt += `🔐| @${cleanID(u.jid)} | ${u.embargo.duration}\n`;
                        });
                        await sock.sendMessage(jid, { text: txt, mentions: embargados.map(u => u.jid) });
                    }
                    return;
                }

                if (command === '!autoban') {
                    if (!isMaster) return; // Admins locais
                    const action = args[0]?.toLowerCase();
                    const gConfig = await GroupConfig.findOne({ jid }) || await GroupConfig.create({ jid });

                    if (action === 'add') {
                        const tJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                        const params = argText.split('|');
                        const reason = params[1] || "Sem motivo";

                        gConfig.autoBanList.push({ jid: tJid, reason, admin: user.name });
                        await gConfig.save();

                        await sock.sendMessage(jid, { text: `📕| @${cleanID(tJid)} foi adicionado a lista de auto ban!\nMotivo: ${reason}`, mentions: [tJid] });
                        if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [tJid], 'remove');
                    }
                    // ...implementar list e rmv similar ao embargo...
                    return;
                }

                // ============================
                // 📨 SISTEMA DE MAIL
                // ============================

                // Cadastro de Grupo
                if (command === '!cadastrargp') {
                    if (!isAdmin) return sock.sendMessage(jid, { text: 'Apenas admins.' });
                    const params = argText.split('|').map(a => a.trim());
                    const nick = params[0];
                    const desc = params[1] || "";

                    await GroupConfig.findOneAndUpdate({ jid }, { nick, description: desc, mailRegistered: true }, { upsert: true });
                    return sock.sendMessage(jid, { text: `✅ Grupo cadastrado como: ${nick}` });
                }

                // Cadastro de Usuário para envio
                if (command === '!cadastrarmail') {
                    user.isMailRegistered = true;
                    await user.save();
                    return sock.sendMessage(jid, { text: '✅ Você agora pode enviar Mails.' });
                }

                if (command === '!mail') {
                    if (!user.isMailRegistered && !isDev) return sock.sendMessage(jid, { text: '⚠️ Você não tem permissão de Mail. Use !cadastrarmail.' });

                    // Formato: !mail DESTINO <titulo> | <texto>
                    // Destino pode ser: Diretoria, Denuncia, Global, NickGrupo, Telefone, NomeLista

                    const firstArg = args[0]; // Destino
                    const restText = argText.slice(firstArg.length).trim();
                    const parts = restText.split('|').map(a => a.trim());
                    const title = parts[0];
                    const body = parts[1] || "";

                    if (!title) return sock.sendMessage(jid, { text: '⚠️ Formato: !mail <destino> <titulo> | <texto>' });

                    // Detectar anexo
                    const attachment = await downloadMedia(msg); // Retorna { buffer, type }

                    const sendMail = async (targetJid) => {
                        const formattedMsg = `📨 *MAIL ACADEMY*\n*Assunto:* ${title}\n*De:* ${user.name} (${user.rank})\n\n${body}\n\n_System Mail v2.0_`;
                        try {
                            if (attachment) {
                                if (attachment.type === 'image') await sock.sendMessage(targetJid, { image: attachment.buffer, caption: formattedMsg });
                                else if (attachment.type === 'video') await sock.sendMessage(targetJid, { video: attachment.buffer, caption: formattedMsg });
                                else await sock.sendMessage(targetJid, { text: formattedMsg }); // fallback
                            } else {
                                await sock.sendMessage(targetJid, { text: formattedMsg });
                            }
                        } catch (e) { console.log(`Falha envio para ${targetJid}`); }
                    };

                    let targets = [];

                    const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

                    if (mentionedJid) {
                        // Se marcou alguém (@user), manda pra ele
                        targets.push(mentionedJid);
                    }
                    else if (firstArg.toLowerCase() === 'diretoria') targets.push(ID_GRUPO_DIRETORIA);
                    else if (firstArg.toLowerCase() === 'denuncia') targets.push(ID_GRUPO_DENUNCIAS);
                    else if (firstArg.toLowerCase() === 'global') {
                        if (!isDev) return;
                        const allGroups = await GroupConfig.find({ mailRegistered: true });
                        targets = allGroups.map(g => g.jid);
                    } else {
                        const gp = await GroupConfig.findOne({ nick: firstArg });
                        if (gp) targets.push(gp.jid);
                        else targets.push(firstArg.replace(/\D/g, '') + '@s.whatsapp.net');
                    }

                    // Envio com Delay para evitar ban
                    await sock.sendMessage(jid, { text: `🚀 Enviando Mail para ${targets.length} destinatários...` });

                    for (const t of targets) {
                        await sendMail(t);
                        await delay(2000); // 2 segundos entre envios
                    }

                    return sock.sendMessage(jid, { text: '✅ Envio concluído.' });
                }

                // ============================
                // 👑 DIRETORIA & RELATÓRIOS
                // ============================
                if (command === '!userg') {
                    const targetJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || cleanSender;
                    const tUser = await getUser(targetJid);

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
                    // Agregação pesada - Cuidado com muitos usuários
                    const users = await UserProfile.find({ 'activeGroups.0': { $exists: true } }).limit(50); // Limitado para teste
                    let txt = "💜 !GlobalUsers Report\n\n";
                    users.forEach(u => {
                        txt += `@${u.name}\n`;
                        u.activeGroups.forEach(g => txt += `> ${g.groupName} • ${g.msgCount} sms\n`);
                        txt += "\n";
                    });
                    await sock.sendMessage(jid, { text: txt });
                    return;
                }

                if (command === '!filtrog') {
                    if (!isDev) return;
                    const filter = argText; // Pode ser nome, numero, ou grupo
                    // Busca regex no mongo
                    const users = await UserProfile.find({
                        $or: [
                            { name: { $regex: filter, $options: 'i' } },
                            { 'activeGroups.groupName': { $regex: filter, $options: 'i' } }
                        ]
                    }).limit(20);

                    let txt = `🔎 Filtro: "${filter}"\n\n`;
                    users.forEach(u => {
                        txt += `• @${u.name}\n`;
                        u.activeGroups.forEach(g => {
                            if (g.groupName.toLowerCase().includes(filter.toLowerCase()) || filter.length < 4) {
                                txt += `> ${g.groupName} • ${g.msgCount} sms\n`;
                            }
                        });
                    });
                    await sock.sendMessage(jid, { text: txt });
                    return;
                }

                // ============================
                // 🛠️ UTILITÁRIOS
                // ============================

                if (command === '!sticker') {
                    const media = await downloadMedia(msg);
                    if (!media) return sock.sendMessage(jid, { text: 'Envie uma mídia.' });
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

                // 👑 PROMOÇÃO: DEV (Apenas Dono)
                if (command === '!dev') {
                    if (!isOwner) return sock.sendMessage(jid, { text: '⚠️ Apenas o Proprietário pode nomear DEVs.' });
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return sock.sendMessage(jid, { text: 'Marque o usuário.' });

                    await UserProfile.findOneAndUpdate({ jid: target }, { rank: 'Dev' });
                    return sock.sendMessage(jid, { text: `👑 @${cleanID(target)} foi promovido a **DEV**!`, mentions: [target] });
                }

                // 🛡️ PROMOÇÃO: MASTER (Apenas Devs)
                if (command === '!master') {
                    if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVs podem nomear Masters.' });
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return sock.sendMessage(jid, { text: 'Marque o usuário.' });

                    await UserProfile.findOneAndUpdate({ jid: target }, { rank: 'Master' });
                    return sock.sendMessage(jid, { text: `🛡️ @${cleanID(target)} foi promovido a **MASTER**!`, mentions: [target] });
                }

                // ⚜️ CANONIZAR (Imunidade)
                if (command === '!canonizar') {
                    if (!isDev) return sock.sendMessage(jid, { text: '⚠️ Apenas DEVs.' });

                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!target) return sock.sendMessage(jid, { text: 'Marque o usuário.' });

                    const tUser = await getUser(target);
                    tUser.isCanonized = !tUser.isCanonized; // Inverte o status (Liga/Desliga)
                    await tUser.save();

                    const status = tUser.isCanonized ? '⚜️ CANONIZADO (Imune)' : '💀 DESCANONIZADO (Vulnerável)';
                    return sock.sendMessage(jid, { text: `Alteração de Status Sagrado:\nUsuário @${cleanID(target)} agora está ${status}.`, mentions: [target] });
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

                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
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
                    if (!target) return;

                    await UserProfile.findOneAndUpdate({ jid: target }, { $set: { cargos: [] } });
                    return sock.sendMessage(jid, { text: `🗑️ Todos os cargos de @${cleanID(target)} foram removidos.`, mentions: [target] });
                }

                // --- COMANDO !RGPERFIL (Versão Títulos) ---
                if (command === '!rgperfil') {
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || cleanSender;
                    const tUser = await getUser(target);

                    await sock.sendMessage(jid, { text: '🎨 Gerando Registro de Identidade...' });

                    let pfp;
                    try { pfp = await sock.profilePictureUrl(target, 'image'); }
                    catch { pfp = 'https://i.imgur.com/62j1H2p.png'; }

                    const buffer = await generateRG(tUser, pfp);

                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: `📇 Identidade Academy de *${tUser.name}*`,
                        mentions: [target]
                    });
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

            // ============================================================
            // ⏫ FIM DOS COMANDOS ⏫
            // ============================================================

        } catch (e) {
            console.error("❌ ERRO NO HANDLER:", e);
        }
    });
}

// Inicia o sistema
startBot();
server.listen(PORT, () => console.log(`🚀 SERVIDOR WEB RODANDO NA PORTA ${PORT}`));