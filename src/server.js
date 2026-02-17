// ============================================
// SERVEUR WHATSAPP 7G CONNECT - VERSION RENDER FINALE
// ============================================

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3001;
const API_TOKEN = process.env.API_TOKEN || 'wx78hj39dk45ls92nq61bv83';
const LARAVEL_API_URL = 'https://7g-connect.yoovoyagedz.com/api';

// ============================================
// FONCTION DE RECHERCHE AUTOMATIQUE DE CHROME
// ============================================
function findChromePath() {
    console.log('[CHROME] Recherche de Chrome...');
    
    try {
        const { execSync } = require('child_process');
        const chromePath = execSync('find /opt/render/.cache/puppeteer -name chrome -type f 2>/dev/null | head -1').toString().trim();
        
        if (chromePath) {
            console.log(`[CHROME] ✅ Trouvé: ${chromePath}`);
            return chromePath;
        }
    } catch (e) {
        console.log('[CHROME] ⚠️ Recherche automatique échouée');
    }
    
    // Chemins alternatifs au cas où
    const alternativePaths = [
        '/opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
        '/opt/render/.cache/puppeteer/chrome/chrome-linux64/chrome'
    ];
    
    console.log('[CHROME] ℹ️ Utilisation du chemin par défaut Puppeteer');
    return null;
}

// ============================================
// INITIALISATION WHATSAPP - OPTIMISÉ POUR RENDER
// ============================================
const chromePath = findChromePath();

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: '7g-connect-bot'
    }),
    puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// État de connexion
let isReady = false;
let clientInfo = null;

// ============================================
// GESTION DU QR CODE
// ============================================
client.on('qr', (qr) => {
    console.log('\n[QR] 🔵 NOUVEAU QR CODE GÉNÉRÉ :');
    qrcode.generate(qr, { small: true });
    console.log('\n[SCAN] 📱 Scannez ce QR code avec votre WhatsApp pour connecter le bot');
    
    // Sauvegarder le QR pour affichage web
    if (!fs.existsSync('public')) fs.mkdirSync('public');
    require('qrcode').toFile('public/qr.png', qr, function(err) {
        if (!err) console.log('[QR] ✅ QR code sauvegardé dans public/qr.png');
    });
});

// ============================================
// CONNEXION RÉUSSIE
// ============================================
client.on('ready', async () => {
    console.log('\n[SUCCÈS] 🟢 WhatsApp connecté avec succès !');
    isReady = true;
    
    // Récupérer les infos du compte
    clientInfo = client.info;
    console.log(`[INFO] 📱 Connecté en tant que: ${clientInfo.pushname} (${clientInfo.me.user})`);
    
    // Notifier Laravel que le bot est prêt
    try {
        await axios.post(`${LARAVEL_API_URL}/whatsapp/status`, {
            status: 'connected',
            phone: clientInfo.me.user,
            timestamp: new Date().toISOString()
        }, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        });
        console.log('[INFO] ✅ Notification envoyée à Laravel');
    } catch (error) {
        console.error('[ERREUR] ❌ Notification Laravel:', error.message);
    }
});

// ============================================
// RECEVOIR LES MESSAGES
// ============================================
client.on('message', async (message) => {
    console.log(`[MESSAGE] 📩 De ${message.from}: ${message.body.substring(0, 50)}${message.body.length > 50 ? '...' : ''}`);
    
    // Envoyer la notification à Laravel
    try {
        await axios.post(`${LARAVEL_API_URL}/whatsapp/webhook`, {
            from: message.from,
            body: message.body,
            timestamp: message.timestamp,
            type: message.type,
            hasMedia: message.hasMedia
        }, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        });
        
        // Répondre automatiquement si demande de signature
        if (message.body.toLowerCase().includes('signature') || 
            message.body.toLowerCase().includes('engagement')) {
            await message.reply('[SIGNATURE] Votre demande de signature a été reçue. Un lien vous sera envoyé sous peu.');
            console.log('[MESSAGE] ✅ Réponse automatique envoyée');
        }
    } catch (error) {
        console.error('[ERREUR] ❌ Webhook Laravel:', error.message);
    }
});

// ============================================
// DÉCONNEXION
// ============================================
client.on('disconnected', (reason) => {
    console.log('[DÉCONNECTÉ] 🔴 WhatsApp déconnecté:', reason);
    isReady = false;
    
    // Notifier Laravel
    axios.post(`${LARAVEL_API_URL}/whatsapp/status`, {
        status: 'disconnected',
        reason: reason,
        timestamp: new Date().toISOString()
    }).catch(() => {});
});

// ============================================
// MIDDLEWARE D'AUTHENTIFICATION
// ============================================
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== API_TOKEN) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
};

// ============================================
// API ENDPOINTS
// ============================================

// Vérifier le statut
app.get('/api/status', authenticate, (req, res) => {
    res.json({
        connected: isReady,
        clientInfo: clientInfo,
        timestamp: new Date().toISOString()
    });
});

// Envoyer un message texte
app.post('/api/send-message', authenticate, async (req, res) => {
    const { to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const response = await client.sendMessage(chatId, message);
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Envoyer un lien de signature
app.post('/api/send-signature', authenticate, async (req, res) => {
    const { to, doctorName, signatureUrl } = req.body;
    
    if (!to || !doctorName || !signatureUrl) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        
        const message = `🩺 *7G Connect - Engagement sur l'honneur*\n\n` +
            `Bonjour Dr. ${doctorName},\n\n` +
            `Pour finaliser votre inscription, veuillez cliquer sur le lien ci-dessous :\n\n` +
            `${signatureUrl}\n\n` +
            `Ce lien expirera dans 24 heures.`;
        
        const response = await client.sendMessage(chatId, message);
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Envoyer un code de vérification
app.post('/api/send-verification', authenticate, async (req, res) => {
    const { to, code } = req.body;
    
    if (!to || !code) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        
        const message = `🔐 *Code de vérification 7G Connect*\n\n` +
            `Votre code est : *${code}*\n\n` +
            `Ce code est valable 10 minutes.`;
        
        const response = await client.sendMessage(chatId, message);
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// INTERFACE WEB POUR LE QR CODE
// ============================================
app.get('/', (req, res) => {
    const qrExists = fs.existsSync('public/qr.png');
    const statusClass = isReady ? 'connected' : 'waiting';
    const statusText = isReady ? '✅ Connecté' : '⏳ En attente de scan';
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>7G Connect - WhatsApp Service</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0;
                    padding: 20px;
                }
                .container {
                    max-width: 600px;
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 30px;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                h1 { font-size: 28px; margin-bottom: 10px; }
                .status {
                    display: inline-block;
                    padding: 8px 20px;
                    border-radius: 50px;
                    font-size: 14px;
                    font-weight: 600;
                    margin: 20px 0;
                }
                .status.connected { background: #10b981; }
                .status.waiting { background: #f59e0b; }
                .qr-container {
                    background: white;
                    padding: 20px;
                    border-radius: 10px;
                    display: inline-block;
                    margin: 20px 0;
                }
                .qr-container img { max-width: 300px; height: auto; }
                .info {
                    background: rgba(0,0,0,0.2);
                    padding: 15px;
                    border-radius: 10px;
                    margin: 20px 0;
                    font-size: 14px;
                }
                .footer {
                    margin-top: 20px;
                    font-size: 12px;
                    opacity: 0.7;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 7G Connect</h1>
                <p>Service WhatsApp professionnel</p>
                
                <div class="status ${statusClass}">
                    ${statusText}
                </div>
                
                <div class="qr-container">
                    ${qrExists 
                        ? '<img src="/qr.png?' + Date.now() + '" alt="QR Code">' 
                        : '<p style="color: #666;">QR code en cours de génération...</p>'}
                </div>
                
                ${clientInfo ? `
                <div class="info">
                    <p><strong>📱 Connecté en tant que:</strong><br>
                    ${clientInfo.pushname} (${clientInfo.me.user})</p>
                </div>
                ` : ''}
                
                <div class="info">
                    <p><strong>🔌 API Endpoints</strong></p>
                    <p style="font-size: 12px; text-align: left;">
                    • GET  /api/status - Vérifier le statut<br>
                    • POST /api/send-message - Envoyer un message<br>
                    • POST /api/send-signature - Envoyer un lien de signature<br>
                    • POST /api/send-verification - Envoyer un code
                    </p>
                </div>
                
                <div class="footer">
                    Token API: ${API_TOKEN.substring(0, 8)}...<br>
                    7G Connect © ${new Date().getFullYear()}
                </div>
            </div>
            
            <script>
                setTimeout(() => {
                    location.reload();
                }, 10000);
            </script>
        </body>
        </html>
    `);
});

// Servir les fichiers statiques
app.use(express.static('public'));

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================
app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Serveur web démarré sur le port ${PORT}`);
    console.log(`[SERVER] 🔑 Token API: ${API_TOKEN.substring(0, 8)}...`);
    console.log('[SERVER] 🚀 Démarrage du client WhatsApp...');
});

// Démarrer le client WhatsApp
client.initialize();

// Gestion de l'arrêt
process.on('SIGINT', async () => {
    console.log('\n[ARRÊT] 🛑 Arrêt du service...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[ARRÊT] 🛑 Arrêt du service...');
    await client.destroy();
    process.exit(0);
});