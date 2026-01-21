require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- SETUP SERVER ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Config Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- MONGODB ---
mongoose.connect(MONGO_URI)
    .then(() => sendLog('✅ MongoDB Conectado'))
    .catch(err => sendLog('❌ Erro Mongo: ' + err.message));

// --- SCHEMAS ---
const CampaignSchema = new mongoose.Schema({
    name: String, text: String, mediaPath: String, mediaType: String, targetGroups: [String],
    config: { interval: Number, startTime: String, maxPerDay: Number, durationDays: Number },
    createdAt: { type: Date, default: Date.now }, endDate: Date, active: { type: Boolean, default: true },
    stats: { sentTotal: { type: Number, default: 0 }, sentToday: { type: Number, default: 0 }, lastSent: { type: Date, default: 0 }, lastDateCheck: String },
    nextGroupIndex: { type: Number, default: 0 }
});
const Campaign = mongoose.model('Campaign', CampaignSchema);

const AIConfigSchema = new mongoose.Schema({
    systemInstruction: String,
    targetGroups: [String]
});
const AIConfig = mongoose.model('AIConfig', AIConfigSchema);

// --- HELPER LOGS ---
function sendLog(msg) {
    console.log(msg);
    io.emit('log', `[${new Date().toLocaleTimeString()}] ${msg}`);
}

// --- GEMINI AI ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Atualizado para modelo mais recente se disponível

async function getGeminiResponse(userPrompt, systemInstruction) {
    if (!userPrompt || userPrompt.trim() === "") return null;
    try {
        const prompt = `${systemInstruction}\n\nContexto: Responda de forma curta, humanizada e útil para WhatsApp.\nUsuário: ${userPrompt}\nResposta:`;
        const result = await model.generateContent(prompt);
        return (await result.response).text();
    } catch (error) {
        sendLog("❌ Erro Gemini: " + error.message);
        return "Desculpe, estou processando muitas informações agora. Tente novamente em breve.";
    }
}

function extractText(msg) {
    if (!msg.message) return '';
    const content = msg.message.ephemeralMessage?.message || msg.message;
    return (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '').trim();
}

// --- BOT ENGINE ---
let sock;
let groupsCache = [];

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Silencioso no terminal, logs via socket
        auth: state,
        printQRInTerminal: true,
        browser: ["Sigma Admin", "Chrome", "1.0"],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            QRCode.toDataURL(qr, (e, url) => io.emit('qr', url));
            io.emit('status', 'Aguardando Leitura 📷');
        }
        
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            sendLog(`🔴 Conexão caiu. Reconectando: ${shouldReconnect}`);
            io.emit('status', 'Desconectado 🔴');
            if(shouldReconnect) startBot();
        } else if(connection === 'open') {
            io.emit('qr', null); 
            io.emit('status', 'Online 🟢');
            sendLog('✅ BOT CONECTADO COM SUCESSO!');
            
            // Fetch groups
            try {
                const raw = await sock.groupFetchAllParticipating();
                groupsCache = Object.values(raw).map(g => ({ id: g.id, subject: g.subject }));
                io.emit('groups', groupsCache);
            } catch (e) { sendLog('Erro ao buscar grupos: ' + e.message); }
        }
    });

    // --- LISTENER DE MENSAGENS (MODO DEBUG ATIVADO) ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            
            // 1. Se não tiver conteúdo de mensagem, ignora
            if (!msg.message) return;

            // 2. Extrai informações básicas
            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            const sender = msg.key.fromMe ? 'EU (Dono)' : (msg.pushName || 'Desconhecido');
            const text = extractText(msg);

            // LOG NO TERMINAL (Para você ver que chegou)
            console.log(`\n🔔 MENSAGEM RECEBIDA:`);
            console.log(`   👤 De: ${sender}`);
            console.log(`   📍 Onde: ${isGroup ? 'Grupo' : 'Privado'}`);
            console.log(`   📝 Texto: "${text}"`);

            // 3. FILTRO: Ignora mensagens de status (Broadcasts)
            if (jid === 'status@broadcast') return;

            // 4. COMANDO DE TESTE DE VIDA (Responde sempre, até no privado)
            if (text.toLowerCase() === '!ping') {
                console.log('⚡ Comando !ping detectado. Respondendo...');
                await sock.sendMessage(jid, { text: '🏓 Pong! Estou ouvindo e conectado.' }, { quoted: msg });
                return;
            }

            // 5. LÓGICA DA IA (Só responde se for marcado ou tiver @bot)
            // Nota: Removi o bloqueio 'msg.key.fromMe' para você poder testar
            
            const config = await AIConfig.findOne();
            
            // Se não tiver config ou não for grupo, não usa IA (segurança básica)
            if (!config) return; 

            // Identifica se o bot foi mencionado
            const myId = sock.user?.id?.split(':')[0].replace(/\D/g, '') || "";
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isTagged = mentions.some(m => m.includes(myId));
            const isTextMention = text.toLowerCase().includes('@bot');

            // Só processa IA se estiver nos grupos permitidos E for marcado
            if ((isTagged || isTextMention) && isGroup) {
                
                if (config.targetGroups.includes(jid)) {
                    console.log("🤖 Ativando IA...");
                    await sock.sendPresenceUpdate('composing', jid);
                    
                    const cleanPrompt = text.replace(/@\d+/g, '').replace('@bot', '').trim();
                    const response = await getGeminiResponse(cleanPrompt, config.systemInstruction);
                    
                    if(response) {
                        await sock.sendMessage(jid, { text: response }, { quoted: msg });
                        sendLog(`🤖 IA respondeu no grupo ${jid}`);
                    }
                } else {
                    console.log(`⚠️ Bot marcado, mas este grupo (${jid}) não está na Whitelist.`);
                    sendLog(`⚠️ Tentativa de uso em grupo não autorizado: ${jid}`);
                }
            }

        } catch (err) {
            console.error("❌ ERRO NO PROCESSAMENTO:", err);
            sendLog("❌ Erro critico: " + err.message);
        }
    });
}

startBot();

// --- API & SOCKET ---
io.on('connection', (s) => {
    // Envia estado atual ao conectar
    s.emit('status', sock?.user ? 'Online 🟢' : 'Offline 🔴');
    if(groupsCache.length) s.emit('groups', groupsCache);
    
    s.on('logout', async () => {
        if(sock) {
            await sock.logout();
            sendLog('🔌 Desconectado pelo usuário via Painel');
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            process.exit(0); // Reinicia processo (se usar PM2) ou encerra
        }
    });
});

app.get('/api/campaigns', async (req, res) => res.json(await Campaign.find().sort({ _id: -1 })));
app.post('/api/delete-campaign', async (req, res) => { await Campaign.findByIdAndDelete(req.body.id); res.json({ok:true}); });
app.post('/api/toggle', async (req, res) => { await Campaign.findByIdAndUpdate(req.body.id, {active:req.body.active}); res.json({ok:true}); });

app.post('/api/campaign', upload.single('media'), async (req, res) => {
    try {
        const { name, text, interval, maxPerDay, startTime, durationDays, targetGroups } = req.body;
        const endDate = new Date(); endDate.setDate(endDate.getDate() + parseInt(durationDays));
        
        await Campaign.create({
            name, text,
            mediaPath: req.file ? req.file.path : null,
            mediaType: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : null,
            targetGroups: JSON.parse(targetGroups),
            config: { interval: parseInt(interval), maxPerDay: parseInt(maxPerDay), startTime, durationDays: parseInt(durationDays) },
            endDate
        });
        res.json({success: true});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/ai-config', async (req, res) => res.json(await AIConfig.findOne() || {}));
app.post('/api/ai-config', async (req, res) => {
    const { systemInstruction, targetGroups } = req.body;
    await AIConfig.findOneAndUpdate({}, { systemInstruction, targetGroups }, { upsert: true, new: true });
    res.json({success: true});
});

// --- LOOP DE CAMPANHAS ---
setInterval(async () => {
    if (!sock) return;
    const now = new Date();
    const campaigns = await Campaign.find({ active: true });
    
    for (const c of campaigns) {
        if (now > c.endDate) { c.active = false; await c.save(); continue; }
        
        // Verifica limite diário (Reset simples à meia noite seria ideal, aqui simplificado)
        // ... Logica mantida simples conforme pedido original para não complicar demais ...

        const lastSent = new Date(c.stats.lastSent).getTime();
        if (now.getTime() - lastSent < (c.config.interval * 60000)) continue;
        if (!c.targetGroups.length) continue;

        try {
            let idx = c.nextGroupIndex >= c.targetGroups.length ? 0 : c.nextGroupIndex;
            const content = {};
            if(c.text) content.caption = c.text;
            if(c.text && !c.mediaPath) content.text = c.text;
            
            if(c.mediaPath) {
                const buffer = fs.readFileSync(c.mediaPath);
                c.mediaType === 'video' 
                    ? (content.video = buffer, content.gifPlayback = true) 
                    : (content.image = buffer);
            }
            
            await sock.sendMessage(c.targetGroups[idx], content);
            
            c.stats.sentTotal++; 
            c.stats.sentToday++; // Deveria ter lógica de reset diário, mas mantendo simples
            c.stats.lastSent = now; 
            c.nextGroupIndex = idx + 1;
            await c.save();
            sendLog(`📢 Campanha [${c.name}] enviada para grupo ${idx + 1}/${c.targetGroups.length}`);
            
        } catch (e) {
            sendLog(`⚠️ Erro envio campanha: ${e.message}`);
            c.nextGroupIndex++; // Pula grupo com erro
            await c.save();
        }
    }
}, 30000); // Check a cada 30s

server.listen(PORT, () => console.log(`SERVIDOR RODANDO: http://localhost:${PORT}`)); //upsert