const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
const PORT = 3000;
const MONGO_URI = "mongodb+srv://sigmadabahia2005_db_user:1uFuLaoKK2skDJZf@cluster0.55astjs.mongodb.net/?appName=Cluster0";
const GEMINI_API_KEY = "AIzaSyCCOth8ZCHMXmgpJf1frm2HBHs9i6BB7Js"; 

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
    .then(() => console.log('✅ MongoDB Conectado'))
    .catch(err => console.error('❌ Erro Mongo:', err));

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

// --- GEMINI AI ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function getGeminiResponse(userPrompt, systemInstruction) {
    console.log("🤖 Consultando Gemini...");
    if (!userPrompt || userPrompt.trim() === "") return "Olá! Vi que me marcou.";
    
    try {
        const prompt = `${systemInstruction}\n\nContexto: Responda de forma curta e direta.\nUsuário: ${userPrompt}\nResposta:`;
        const result = await model.generateContent(prompt);
        const text = (await result.response).text();
        console.log("🤖 Gemini respondeu:", text);
        return text;
    } catch (error) {
        console.error("❌ Erro Gemini:", error.message);
        return "Erro na IA: " + error.message;
    }
}

// Função de texto blindada
function extractText(msg) {
    if (!msg.message) return '';
    const content = msg.message.ephemeralMessage?.message || msg.message;
    return (
        content.conversation || 
        content.extendedTextMessage?.text || 
        content.imageMessage?.caption || 
        content.videoMessage?.caption || 
        ''
    ).trim();
}

// --- BOT ENGINE ---
let sock;
let groupsCache = [];

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // LOG LEVEL 'warn' para limpar o terminal, mas mostrar erros críticos
    sock = makeWASocket({
        logger: pino({ level: 'warn' }), 
        auth: state,
        printQRInTerminal: false,
        browser: ["Sigma Bot", "Chrome", "3.0"]
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        if(u.qr) QRCode.toDataURL(u.qr, (e, url) => io.emit('qr', url));
        
        if(u.connection === 'open') {
            io.emit('qr', null); 
            io.emit('status', 'Online 🟢');
            console.log('✅ BOT ONLINE AGORA! PODE MANDAR MENSAGEM.');
            
            const raw = await sock.groupFetchAllParticipating();
            groupsCache = Object.values(raw).map(g => ({ id: g.id, subject: g.subject }));
            io.emit('groups', groupsCache);
        } else if(u.connection === 'close') {
            const shouldReconnect = (u.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`🔴 Conexão caiu. Reconectando...`);
            if(shouldReconnect) startBot();
        }
    });

    // --- LISTENER MODO BRUTO ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            const text = extractText(msg);
            
            // FILTRO DE SEGURANÇA MÍNIMA: Se não tiver texto, ignora.
            if (!text) return;

            // 1. LOG FORÇADO NO TERMINAL (Pra provar que chegou)
            console.log('\n------------------------------------------------');
            console.log(`📩 RECEBIDO DE: ${jid}`);
            console.log(`👤 QUEM MANDOU: ${msg.key.fromMe ? 'EU (Dono)' : 'OUTRO'}`);
            console.log(`📝 TEXTO: "${text}"`);

            // 2. COMANDO DE TESTE DE VIDA (Ignora Banco de Dados)
            if (text.toLowerCase() === '!teste') {
                console.log("⚡ Comando !teste recebido. Enviando resposta...");
                await sock.sendMessage(jid, { text: `✅ O Bot está vivo!\nID deste grupo: ${jid}` }, { quoted: msg });
                return;
            }

            // 3. VERIFICAÇÃO DE MENÇÃO
            // Vamos considerar qualquer menção (@bot ou resposta)
            const isGroup = jid.endsWith('@g.us');
            const myId = sock.user?.id?.split(':')[0].replace(/\D/g, '') || "";
            
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isTagged = mentions.some(m => m.includes(myId));
            const isTextMention = text.toLowerCase().includes('@bot');
            
            // SE O TEXTO TIVER @bot OU FOR UMA MENÇÃO, VAMOS TENTAR PROCESSAR
            if (isTagged || isTextMention) {
                console.log("👀 O BOT FOI MARCADO.");

                if (!isGroup) {
                    await sock.sendMessage(jid, { text: "Sou um bot e funciono apenas em grupos configurados." }, { quoted: msg });
                    return;
                }

                // 4. CONSULTA O BANCO DE DADOS E MOSTRA O QUE TEM LÁ
                const config = await AIConfig.findOne();
                
                if (!config) {
                    console.log("❌ ERRO CRÍTICO: Não existe nenhuma configuração de IA no MongoDB (AIConfig is null).");
                    await sock.sendMessage(jid, { text: "⚠️ Erro: IA não configurada no painel." });
                    return;
                }

                console.log("📂 Grupos Permitidos no Mongo:", config.targetGroups);
                console.log("📍 Grupo Atual:", jid);

                // 5. COMPARAÇÃO
                if (config.targetGroups.includes(jid)) {
                    console.log("✅ ID BATEU! ENVIANDO PARA A IA...");
                    await sock.sendPresenceUpdate('composing', jid);
                    
                    const cleanPrompt = text.replace(/@\d+/g, '').replace('@bot', '').trim();
                    const response = await getGeminiResponse(cleanPrompt, config.systemInstruction || "Você é um assistente útil.");
                    
                    await sock.sendMessage(jid, { text: response }, { quoted: msg });
                    console.log("🚀 MENSAGEM ENVIADA.");
                } else {
                    console.log("⛔ BLOQUEADO: O ID do grupo atual NÃO está na lista do MongoDB.");
                    console.log(`👉 Copie este ID: ${jid}`);
                    console.log(`👉 E coloque no array targetGroups no Mongo.`);
                }
            }

        } catch (err) {
            console.error("❌ DEU MERDA NO CÓDIGO:", err);
        }
    });
}
startBot();

// --- API ---
io.on('connection', (s) => {
    s.emit('status', sock ? 'Online 🟢' : 'Offline 🔴');
    if(groupsCache.length) s.emit('groups', groupsCache);
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
                c.mediaType === 'video' ? (content.video = buffer, content.gifPlayback = true) : (content.image = buffer);
            }
            await sock.sendMessage(c.targetGroups[idx], content);
            c.stats.sentTotal++; c.stats.lastSent = now; c.nextGroupIndex = idx + 1;
            await c.save();
        } catch (e) { c.nextGroupIndex++; await c.save(); }
    }
}, 20000);

server.listen(PORT, () => console.log(`SERVIDOR: http://localhost:${PORT}`));