const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- BANCO DE DADOS GERAL (RECHEADO) ---
const DB_FILE = 'database.json';
const defaultDB = {
    settings: { minDelay: 2000, maxDelay: 5000 },
    commands: [],
    flows: {},
    groups: [],
    rpg: {
        active: false,
        targetGroup: null,
        cooldown: 60,
        drops: [
            { name: 'Madeira', icon: '🪵', chance: 70, min: 2, max: 6, tier: 1 },
            { name: 'Pedra', icon: '🪨', chance: 60, min: 2, max: 5, tier: 1 },
            { name: 'Carvão', icon: '⚫', chance: 40, min: 1, max: 4, tier: 1 },
            { name: 'Ferro', icon: '⛓️', chance: 20, min: 1, max: 3, tier: 2 },
            { name: 'Ouro', icon: '⚱️', chance: 8, min: 1, max: 2, tier: 2 },
            { name: 'Diamante', icon: '💎', chance: 2, min: 1, max: 1, tier: 3 },
            { name: 'Esmeralda', icon: '✳️', chance: 1, min: 1, max: 1, tier: 3 },
            { name: 'Couro', icon: '🟤', chance: 0, min: 0, max: 0, tier: 0 }, // Drop de mob
            { name: 'Carne', icon: '🥩', chance: 0, min: 0, max: 0, tier: 0 }  // Drop de mob
        ],
        crafts: [
            { key: 'pocao_vida', name: 'Poção de Vida', type: 'consumable', heal: 50, cost: [{item:'Carne', qtd:2}, {item:'Ouro', qtd:1}] },
            { key: 'adaga', name: 'Adaga de Pedra', type: 'weapon', atk: 5, cost: [{item:'Pedra', qtd:5}, {item:'Madeira', qtd:2}] },
            { key: 'espada_ferro', name: 'Espada de Ferro', type: 'weapon', atk: 15, cost: [{item:'Ferro', qtd:5}, {item:'Madeira', qtd:2}] },
            { key: 'machado_diamante', name: 'Machado Divino', type: 'weapon', atk: 40, cost: [{item:'Diamante', qtd:3}, {item:'Ouro', qtd:5}] },
            { key: 'capa_couro', name: 'Capa de Couro', type: 'armor', def: 5, cost: [{item:'Couro', qtd:10}] },
            { key: 'peito_ferro', name: 'Peitoral de Ferro', type: 'armor', def: 20, cost: [{item:'Ferro', qtd:10}] }
        ],
        monsters: [
            { name: 'Rato', icon: '🐀', hp: 20, atk: 4, xp: 5, drop: 'Carne', chance: 100 },
            { name: 'Lobo', icon: '🐺', hp: 50, atk: 10, xp: 15, drop: 'Couro', chance: 50 },
            { name: 'Urso', icon: '🐻', hp: 100, atk: 15, xp: 30, drop: 'Carne', chance: 30 },
            { name: 'Bandido', icon: '🥷', hp: 80, atk: 12, xp: 25, drop: 'Ouro', chance: 30 },
            { name: 'Dragão', icon: '🐉', hp: 400, atk: 50, xp: 200, drop: 'Diamante', chance: 5 }
        ]
    }
};

function loadDB() {
    let data = defaultDB;
    if (fs.existsSync(DB_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(DB_FILE));
            data = { ...defaultDB, ...loaded, rpg: { ...defaultDB.rpg, ...(loaded.rpg || {}) } };
            // Garante listas padrão se vazias
            if(!data.rpg.drops.length) data.rpg.drops = defaultDB.rpg.drops;
            if(!data.rpg.crafts.length) data.rpg.crafts = defaultDB.rpg.crafts;
            if(!data.rpg.monsters.length) data.rpg.monsters = defaultDB.rpg.monsters;
        } catch (e) { console.log("Erro DB"); }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    return data;
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// --- PLAYERS ---
const GAME_FILE = 'game_players.json';
let playersDB = {};
if (fs.existsSync(GAME_FILE)) { try { playersDB = JSON.parse(fs.readFileSync(GAME_FILE)); } catch(e){} }
function savePlayers() { fs.writeFileSync(GAME_FILE, JSON.stringify(playersDB, null, 2)); }

function getPlayer(id) {
    if (!playersDB[id]) {
        playersDB[id] = {
            inv: {},
            stats: { hp: 100, maxHp: 100, atk: 3, def: 0, xp: 0, lvl: 1 },
            equip: { weapon: null, armor: null, pickaxe: 1 },
            cooldowns: { mine: 0, hunt: 0, dungeon: 0, base: 0 }
        };
    }
    // Garante estrutura atualizada
    if(!playersDB[id].cooldowns) playersDB[id].cooldowns = { mine:0, hunt:0, dungeon:0, base:0 };
    if(!playersDB[id].stats) playersDB[id].stats = { hp: 100, maxHp: 100, atk: 3, def: 0, xp: 0, lvl: 1 };
    return playersDB[id];
}

let db = loadDB();
let sock;
const activeBattles = {}; 
const userStates = {}; 
const messageQueue = [];
let isProcessingQueue = false;

// --- FILA ---
function queueMessage(jid, content, options = {}) {
    messageQueue.push({ jid, content, options });
    processQueue();
}
async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    const task = messageQueue.shift();
    const delay = Math.floor(Math.random() * (db.settings.maxDelay - db.settings.minDelay + 1) + db.settings.minDelay);
    await new Promise(r => setTimeout(r, delay));
    try { if (sock) await sock.sendMessage(task.jid, task.content, task.options); } catch (e) {}
    isProcessingQueue = false;
    processQueue();
}

// --- RPG HELPERS ---
function calculateStats(p) {
    let totalAtk = p.stats.atk;
    let totalDef = p.stats.def;
    if (p.equip.weapon) {
        const item = db.rpg.crafts.find(c => c.name === p.equip.weapon);
        if (item && item.atk) totalAtk += parseInt(item.atk);
    }
    if (p.equip.armor) {
        const item = db.rpg.crafts.find(c => c.name === p.equip.armor);
        if (item && item.def) totalDef += parseInt(item.def);
    }
    return { atk: totalAtk, def: totalDef };
}

function addXP(p, amount, jid) {
    p.stats.xp += amount;
    const nextLvl = p.stats.lvl * 150; 
    if (p.stats.xp >= nextLvl) {
        p.stats.lvl++;
        p.stats.xp -= nextLvl;
        p.stats.maxHp += 15;
        p.stats.hp = p.stats.maxHp;
        p.stats.atk += 2;
        queueMessage(jid, { text: `🆙 *LEVEL UP!* Nível ${p.stats.lvl} alcançado!` });
    }
    savePlayers();
}

// --- SERVIDOR ---
io.on('connection', s => { if(db.groups) s.emit('groups', db.groups); s.emit('status', sock?'Online':'Off'); });

// --- API ---
app.get('/api/data', (req, res) => res.json(db));
app.post('/api/save-rpg', (req, res) => { db.rpg = { ...db.rpg, ...req.body }; saveDB(); res.json({success:true}); });
app.post('/api/command', (req, res) => { db.commands.push(req.body); saveDB(); res.json({success:true}); });
app.post('/api/delete-command', (req, res) => { db.commands.splice(req.body.index, 1); saveDB(); res.json({success:true}); });
app.post('/api/settings', (req, res) => { db.settings = req.body; saveDB(); res.json({success:true}); });
app.post('/api/flow-step', (req, res) => { 
    const { stepName, trigger, responseText, nextStep } = req.body;
    if (!db.flows[stepName]) db.flows[stepName] = {};
    db.flows[stepName][trigger] = { text: responseText, nextStep: nextStep || null };
    saveDB(); res.json({success:true}); 
});

// --- BOT ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Bot RPG Full", "Chrome", "3.0"],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        if(u.qr) QRCode.toDataURL(u.qr, (e,url)=>io.emit('qr',url));
        if(u.connection==='open') { io.emit('qr',null); io.emit('status','Online'); 
            sock.groupFetchAllParticipating().then(g => {
                db.groups = Object.values(g).map(x=>({id:x.id, subject:x.subject}));
                saveDB(); io.emit('groups', db.groups);
            });
        }
        if(u.connection==='close') startBot();
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            const jid = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
            const senderId = msg.key.participant || jid;
            const cmd = text.toLowerCase();
            if(!text) continue;

            // ============================================
            // 1. SISTEMA DE BATALHA (TURNO A TURNO)
            // ============================================
            if (activeBattles[senderId]) {
                const battle = activeBattles[senderId];
                const p = getPlayer(senderId);
                const s = calculateStats(p);

                // --- COMANDO: FUGIR ---
                if (cmd === '!fugir') {
                    if (Math.random() > 0.4) { // 60% chance fugir
                        delete activeBattles[senderId];
                        queueMessage(jid, { text: '🏃‍♂️ Você escapou por pouco!' }, { quoted: msg });
                    } else {
                        const dmg = Math.max(1, battle.mobAtk - Math.floor(s.def * 0.5));
                        p.stats.hp -= dmg;
                        savePlayers();
                        queueMessage(jid, { text: `🚫 Falha na fuga! Levou ${dmg} de dano.\nHP: ${p.stats.hp}` }, { quoted: msg });
                        if(p.stats.hp <= 0) { delete activeBattles[senderId]; p.stats.hp=1; queueMessage(jid, {text:'💀 Você desmaiou.'}, {quoted:msg}); }
                    }
                    return;
                }

                // --- COMANDO: ATACAR ---
                if (cmd === '!atacar') {
                    // Player ataca
                    const pDmg = Math.floor(s.atk * (0.9 + Math.random() * 0.3));
                    battle.mobHp -= pDmg;
                    
                    let txt = `⚔️ Você causou ${pDmg} dano!`;

                    if (battle.mobHp <= 0) {
                        delete activeBattles[senderId];
                        addXP(p, battle.mobXp, jid);
                        
                        let lootTxt = '';
                        if (Math.random() * 100 < battle.chance) {
                            p.inv[battle.mobDrop] = (p.inv[battle.mobDrop] || 0) + 1;
                            lootTxt = `\n🎒 Loot: 1x ${battle.mobDrop}`;
                        }
                        queueMessage(jid, { text: txt + `\n🏆 O ${battle.mobName} morreu! (+${battle.mobXp} XP)${lootTxt}` }, { quoted: msg });
                    } else {
                        // Mob revida
                        const mDmg = Math.max(1, Math.floor((battle.mobAtk - (s.def * 0.5)) * (0.8 + Math.random() * 0.4)));
                        p.stats.hp -= mDmg;
                        txt += `\n👹 ${battle.mobName} causou ${mDmg} dano.`;
                        txt += `\n\n${battle.mobName}: ${battle.mobHp} HP\nVocê: ${p.stats.hp} HP`;
                        
                        if (p.stats.hp <= 0) {
                            delete activeBattles[senderId];
                            p.stats.hp = 1; p.stats.xp = Math.max(0, p.stats.xp - 20);
                            txt += `\n💀 Você foi derrotado...`;
                        }
                        queueMessage(jid, { text: txt }, { quoted: msg });
                    }
                    savePlayers();
                    return;
                }

                // --- COMANDO: USAR (Em Batalha) ---
                if (cmd.startsWith('!usar ')) {
                    const item = text.substring(6).trim();
                    const itemData = db.rpg.crafts.find(c => c.name.toLowerCase() === item.toLowerCase());
                    if (itemData && itemData.type === 'consumable' && p.inv[itemData.name] > 0) {
                        p.inv[itemData.name]--;
                        const cura = itemData.heal;
                        p.stats.hp = Math.min(p.stats.maxHp, p.stats.hp + cura);
                        
                        // Mob ataca no seu turno de cura
                        const mDmg = Math.max(1, battle.mobAtk - Math.floor(s.def * 0.5));
                        p.stats.hp -= mDmg;
                        
                        queueMessage(jid, { text: `🧪 Curou +${cura} HP, mas levou ${mDmg} dano!\nHP: ${p.stats.hp}` }, { quoted: msg });
                        if(p.stats.hp <= 0) { delete activeBattles[senderId]; p.stats.hp=1; queueMessage(jid, {text:'💀 Morreu bebendo poção.'}, {quoted:msg}); }
                        savePlayers();
                    } else {
                        queueMessage(jid, { text: '❌ Sem item.' }, { quoted: msg });
                    }
                    return;
                }

                if(cmd.startsWith('!')) {
                    queueMessage(jid, { text: '⚠️ Você está lutando! !atacar, !fugir ou !usar' }, { quoted: msg });
                    return;
                }
            }

            // ============================================
            // 2. COMANDOS RPG (FORA DE BATALHA)
            // ============================================
            if (db.rpg.active && db.rpg.targetGroup === jid) {
                const p = getPlayer(senderId);

                if (cmd === '!ajuda' || cmd === '!help') {
                    const txt = `📜 *RPG COMANDOS*\n!minerar, !cacar, !explorar, !base, !inv, !perfil, !crafts, !fazer [item], !equipar [item], !usar [item], !upgrade picareta, !pvp @user`;
                    queueMessage(jid, { text: txt }, { quoted: msg });
                    continue;
                }

                // !CAÇAR (Inicia Batalha)
                if (cmd === '!cacar' || cmd === '!caçar') {
                    if (p.stats.hp < 10) return queueMessage(jid, { text: '🩸 Cure-se primeiro!' }, { quoted: msg });
                    const now = Date.now();
                    if(now - p.cooldowns.hunt < 10000) return queueMessage(jid, { text: '😰 Descanse um pouco...' }, { quoted: msg });
                    p.cooldowns.hunt = now;

                    const mob = db.rpg.monsters[Math.floor(Math.random() * db.rpg.monsters.length)];
                    activeBattles[senderId] = { 
                        mobName: mob.name, mobHp: mob.hp, mobMaxHp: mob.hp, 
                        mobAtk: mob.atk, mobXp: mob.xp, mobDrop: mob.drop, chance: mob.chance 
                    };
                    queueMessage(jid, { text: `⚔️ *${mob.name.toUpperCase()}* ${mob.icon} apareceu! (HP:${mob.hp})\n!atacar | !fugir` }, { quoted: msg });
                    continue;
                }

                // !EXPLORAR (Dungeon)
                if (cmd === '!explorar' || cmd === '!dungeon') {
                    if(p.stats.lvl < 2) return queueMessage(jid, {text:'🔒 Nível 2 necessário.'}, {quoted:msg});
                    const now = Date.now();
                    if(now - p.cooldowns.dungeon < 60000) return queueMessage(jid, {text:'⏳ Masmorra fechada.'}, {quoted:msg});
                    p.cooldowns.dungeon = now;

                    const events = [
                        {t:'Baú de Ouro', dmg:0, loot:{item:'Ouro', qtd:5}},
                        {t:'Armadilha!', dmg:20, xp:0},
                        {t:'Sala de Monstros', dmg:40, xp:50},
                        {t:'Fonte da Vida', heal:100},
                        {t:'O CHEFE DA MASMORRA', dmg:80, xp:200, loot:{item:'Diamante', qtd:2}}
                    ];
                    const ev = events[Math.floor(Math.random()*events.length)];
                    let txt = `🏰 *DUNGEON*\nEncontrou: ${ev.t}\n`;

                    if(ev.dmg) {
                        const s = calculateStats(p);
                        const dmg = Math.max(0, ev.dmg - s.def);
                        p.stats.hp -= dmg;
                        txt += `💔 Dano: ${dmg}\n`;
                    }
                    if(ev.heal) {
                        p.stats.hp = Math.min(p.stats.maxHp, p.stats.hp + ev.heal);
                        txt += `💚 Curou: ${ev.heal}\n`;
                    }
                    if(ev.loot) {
                        p.inv[ev.loot.item] = (p.inv[ev.loot.item]||0) + ev.loot.qtd;
                        txt += `💎 Loot: ${ev.loot.qtd}x ${ev.loot.item}\n`;
                    }
                    if(ev.xp) {
                        addXP(p, ev.xp, jid);
                        txt += `📈 +${ev.xp} XP`;
                    }
                    if(p.stats.hp <= 0) { p.stats.hp=1; txt+='\n💀 Você foi derrotado.'; }
                    savePlayers();
                    queueMessage(jid, { text: txt }, { quoted: msg });
                    continue;
                }

                // !BASE (Home)
                if (cmd === '!base' || cmd === '!casa') {
                    const now = Date.now();
                    if(now - p.cooldowns.base < 30000) { queueMessage(jid, {text:'🏠 Já descansou.'}, {quoted:msg}); continue; }
                    p.cooldowns.base = now;
                    const heal = Math.floor(p.stats.maxHp * 0.2);
                    p.stats.hp = Math.min(p.stats.maxHp, p.stats.hp + heal);
                    savePlayers();
                    queueMessage(jid, { text: `🏠 Descansou na base e recuperou ${heal} HP.\nVida: ${p.stats.hp}/${p.stats.maxHp}` }, { quoted: msg });
                    continue;
                }

                // !UPGRADE PICARETA
                if (cmd === '!upgrade picareta') {
                    const cost = p.equip.pickaxe * 20;
                    if((p.inv['Pedra']||0) < cost) return queueMessage(jid, {text:`❌ Custa ${cost} Pedras.`}, {quoted:msg});
                    p.inv['Pedra'] -= cost;
                    p.equip.pickaxe++;
                    savePlayers();
                    queueMessage(jid, {text:`✨ Picareta Nível ${p.equip.pickaxe}!`}, {quoted:msg});
                    continue;
                }

                // !PVP
                if (cmd.startsWith('!pvp @')) {
                    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if(!target || target === senderId) return queueMessage(jid, {text:'Marque um oponente.'}, {quoted:msg});
                    const p2 = getPlayer(target);
                    const s1 = calculateStats(p);
                    const s2 = calculateStats(p2);
                    
                    // Luta simples baseada em status + sorte
                    const score1 = (s1.atk + s1.def + p.stats.hp) * Math.random();
                    const score2 = (s2.atk + s2.def + p2.stats.hp) * Math.random();
                    
                    let txt = `⚔️ *DUELO*\n`;
                    if(score1 > score2) {
                        txt += `🏆 @${senderId.split('@')[0]} VENCEU!`;
                        addXP(p, 20, jid);
                    } else {
                        txt += `🏆 @${target.split('@')[0]} VENCEU!`;
                        addXP(p2, 20, jid);
                    }
                    queueMessage(jid, { text: txt, mentions:[senderId, target] }, { quoted: msg });
                    continue;
                }

                // !MINERAR
                if (cmd === '!minerar') {
                    const now = Date.now();
                    const red = (p.equip.pickaxe - 1) * 2000;
                    const cd = Math.max(5000, (db.rpg.cooldown * 1000) - red);
                    if(now - p.cooldowns.mine < cd) { queueMessage(jid, {text:`⏳ Espere ${Math.ceil((cd-(now-p.cooldowns.mine))/1000)}s`}, {quoted:msg}); continue; }
                    
                    const luck = (p.equip.pickaxe - 1) * 2;
                    const rand = Math.random() * 100;
                    let drop = null;
                    let acc = 0;
                    for(const d of db.rpg.drops) { acc+=d.chance+(d.tier===1?luck:0); if(rand<=acc){drop=d; break;} }
                    
                    if(drop) {
                        const qtd = Math.floor(Math.random()*(drop.max-drop.min+1))+drop.min;
                        p.inv[drop.name] = (p.inv[drop.name]||0)+qtd;
                        addXP(p, 2, jid);
                        queueMessage(jid, {text:`⛏️ +${qtd} ${drop.name} ${drop.icon}`}, {quoted:msg});
                    } else queueMessage(jid, {text:'💨 Nada.'}, {quoted:msg});
                    p.cooldowns.mine = now; savePlayers(); continue;
                }

                // !CRAFTS & !FAZER (Mantido)
                if(cmd === '!crafts') {
                    let t = `🛠️ *RECEITAS*\n`;
                    db.rpg.crafts.forEach(c => {
                         const info = c.type==='weapon'?`⚔️${c.atk}`:c.type==='armor'?`🛡️${c.def}`:`❤️${c.heal}`;
                         t+=`🔹 !fazer ${c.key} (${c.name} ${info})\n`;
                    });
                    queueMessage(jid, {text:t}, {quoted:msg}); continue;
                }
                if(cmd.startsWith('!fazer ')) {
                    const key = cmd.split(' ')[1];
                    const r = db.rpg.crafts.find(c=>c.key===key);
                    if(!r) return queueMessage(jid,{text:'❌ Receita inválida'},{quoted:msg});
                    if(r.cost.some(m=>(p.inv[m.item]||0)<m.qtd)) return queueMessage(jid,{text:'❌ Falta material'},{quoted:msg});
                    r.cost.forEach(m=>p.inv[m.item]-=m.qtd);
                    p.inv[r.name]=(p.inv[r.name]||0)+1; savePlayers();
                    queueMessage(jid,{text:`✅ Feito: ${r.name}`},{quoted:msg}); continue;
                }

                // !EQUIPAR
                if(cmd.startsWith('!equipar ')) {
                    const n = text.substring(9).trim();
                    const d = db.rpg.crafts.find(c=>c.name.toLowerCase()===n.toLowerCase());
                    if(!d || !p.inv[d.name]) return queueMessage(jid,{text:'❌ Item não encontrado no inv.'},{quoted:msg});
                    if(d.type==='weapon') p.equip.weapon=d.name;
                    if(d.type==='armor') p.equip.armor=d.name;
                    savePlayers(); queueMessage(jid,{text:`🛡️ Equipado: ${d.name}`},{quoted:msg}); continue;
                }
                
                // !USAR (Fora de batalha)
                if(cmd.startsWith('!usar ')) {
                    const n = text.substring(6).trim();
                    const d = db.rpg.crafts.find(c=>c.name.toLowerCase()===n.toLowerCase());
                    if(d && d.type==='consumable' && p.inv[d.name]>0) {
                        p.inv[d.name]--;
                        p.stats.hp = Math.min(p.stats.maxHp, p.stats.hp + d.heal);
                        savePlayers(); queueMessage(jid,{text:`🧪 Curou +${d.heal} HP.`},{quoted:msg});
                    } else queueMessage(jid,{text:'❌ Impossível usar.'},{quoted:msg});
                    continue;
                }

                // !PERFIL
                if(cmd==='!perfil'||cmd==='!status') {
                    const s = calculateStats(p);
                    let t = `👤 *PERFIL*\n❤️ ${p.stats.hp}/${p.stats.maxHp} | 🆙 Lvl ${p.stats.lvl}\n⚔️ Atk ${s.atk} | 🛡️ Def ${s.def}\n⛏️ Picareta Lvl ${p.equip.pickaxe}`;
                    queueMessage(jid, {text:t}, {quoted:msg}); continue;
                }
                if(cmd==='!inv') {
                    let t = `🎒 *INV*: ` + Object.entries(p.inv).filter(x=>x[1]>0).map(x=>`${x[0]}:${x[1]}`).join(', ');
                    queueMessage(jid, {text:t}, {quoted:msg}); continue;
                }
            }

            // --- OUTROS ---
            if (userStates[senderId]) { /* Flow Logic */ 
                const s = db.flows[userStates[senderId]];
                if(s && s[text]) { queueMessage(jid,{text:s[text].text},{quoted:msg}); if(s[text].nextStep) userStates[senderId]=s[text].nextStep; else delete userStates[senderId]; return; }
            }
            const c = db.commands.find(x => text.startsWith(x.trigger));
            if (c) {
                if(c.targetGroup!=='all' && c.targetGroup!==jid) return;
                let r = c.response;
                if(c.type==='random') { /* Random Logic */ }
                else if(c.type==='flow') userStates[senderId]=c.startStep;
                queueMessage(jid, {text:r}, {quoted:msg});
            }
        }
    });
}
startBot();
server.listen(PORT, () => console.log(`FULL RPG SERVER: http://localhost:${PORT}`));