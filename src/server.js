// ============================================
// SERVEUR WHATSAPP 7G CONNECT - VERSION ULTIME OPTIMISÉE
// AVEC SYSTÈME ANTI-DÉCONNEXION RENFORCÉ
// ============================================

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const winston = require('winston');
const cors = require('cors');
const helmet = require('helmet');

dotenv.config();

// ============================================
// CONFIGURATION AVANCÉE
// ============================================
const config = {
    port: process.env.PORT || 3001,
    apiToken: process.env.API_TOKEN || 'wx78hj39dk45ls92nq61bv83',
    laravelApiUrl: process.env.LARAVEL_API_URL || 'https://7g-connect.yoovoyagedz.com/api',
    sessionFile: process.env.SESSION_FILE || './session.json',
    keepAliveInterval: parseInt(process.env.KEEP_ALIVE_INTERVAL) || 30000,
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL) || 5000,
    maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 50,
    maxMemoryMB: parseInt(process.env.MAX_MEMORY_MB) || 450, // 512MB - 62MB marge
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 5000,
    webhookQueueSize: parseInt(process.env.WEBHOOK_QUEUE_SIZE) || 100
};

// ============================================
// LOGGER STRUCTURÉ
// ============================================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

// ============================================
// RATE LIMITING
// ============================================
const rateLimiter = new RateLimiterMemory({
    points: 50, // 50 requêtes
    duration: 60, // par minute
});

// ============================================
// FILE DES MESSAGES (ANTI-BLOCAGE)
// ============================================
class MessageQueue {
    constructor(size = 100) {
        this.queue = [];
        this.size = size;
        this.processing = false;
    }

    async add(message, handler) {
        if (this.queue.length >= this.size) {
            logger.warn('Queue pleine, message ignoré', { from: message.from });
            return;
        }

        this.queue.push({ message, handler });
        this.process();
    }

    async process() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await item.handler(item.message);
            } catch (error) {
                logger.error('Erreur traitement message queue', { error: error.message });
            }
            // Petit délai pour éviter de surcharger
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.processing = false;
    }
}

const messageQueue = new MessageQueue(config.webhookQueueSize);

// ============================================
// MONITORING MÉMOIRE
// ============================================
function checkMemory() {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);
    
    logger.info('Mémoire', { heapUsedMB, rssMB });
    
    if (rssMB > config.maxMemoryMB) {
        logger.error('Mémoire critique, redémarrage nécessaire', { rssMB, max: config.maxMemoryMB });
        // Forcer un garbage collection si disponible
        if (global.gc) {
            global.gc();
        }
        // Redémarrer le processus proprement
        process.exit(1);
    }
    
    return { heapUsedMB, rssMB };
}

// Vérification mémoire toutes les 5 minutes
setInterval(checkMemory, 5 * 60 * 1000);

// ============================================
// FONCTION DE RECHERCHE AUTOMATIQUE DE CHROME
// ============================================
async function findChromePath() {
    logger.info('Recherche de Chrome...');
    
    const paths = [
        ...await findChromeInCache(),
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];
    
    for (const chromePath of paths) {
        if (await fileExists(chromePath)) {
            logger.info('Chrome trouvé', { path: chromePath });
            return chromePath;
        }
    }
    
    logger.warn('Chrome non trouvé, utilisation du défaut Puppeteer');
    return null;
}

async function findChromeInCache() {
    const results = [];
    const basePaths = [
        '/opt/render/.cache/puppeteer',
        process.cwd() + '/.cache/puppeteer'
    ];
    
    for (const basePath of basePaths) {
        try {
            const files = await fs.readdir(basePath);
            for (const file of files) {
                if (file.includes('chrome')) {
                    const fullPath = path.join(basePath, file, 'chrome-linux64', 'chrome');
                    if (await fileExists(fullPath)) {
                        results.push(fullPath);
                    }
                }
            }
        } catch (error) {
            // Ignorer les erreurs de lecture
        }
    }
    
    return results;
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

// ============================================
// ÉTAT DU CLIENT
// ============================================
class WhatsAppClient {
    constructor() {
        this.client = null;
        this.isReady = false;
        this.clientInfo = null;
        this.reconnectAttempts = 0;
        this.keepAliveInterval = null;
        this.reconnectTimeout = null;
        this.startTime = Date.now();
        this.messageCount = 0;
    }

    async initialize() {
        logger.info('Initialisation du client WhatsApp...');
        
        const chromePath = await findChromePath();
        
        const clientConfig = {
            authStrategy: new LocalAuth({
                clientId: '7g-connect-bot',
                dataPath: './.wwebjs_auth'
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
                    '--single-process',
                    '--disable-software-rasterizer',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-background-networking',
                    '--disable-web-security',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-notifications',
                    '--disable-extensions',
                    '--hide-scrollbars',
                    '--mute-audio',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--no-pings'
                ]
            }
        };
        
        this.client = new Client(clientConfig);
        this.setupEvents();
        
        try {
            await this.client.initialize();
        } catch (error) {
            logger.error('Échec initialisation', { error: error.message });
            this.scheduleReconnect();
        }
    }

    setupEvents() {
        if (!this.client) return;

        this.client.on('qr', (qr) => {
            this.handleQR(qr);
        });

        this.client.on('loading_screen', (percent, message) => {
            logger.info('Chargement', { percent, message });
        });

        this.client.on('authenticated', () => {
            logger.info('Authentifié avec succès');
            this.reconnectAttempts = 0;
        });

        this.client.on('auth_failure', (msg) => {
            logger.error('Échec authentification', { msg });
            this.scheduleReconnect();
        });

        this.client.on('ready', () => this.handleReady());

        this.client.on('message', (message) => this.handleMessage(message));

        this.client.on('message_create', (message) => {
            if (message.fromMe) {
                logger.debug('Message envoyé', { id: message.id.id });
            }
        });

        this.client.on('disconnected', (reason) => this.handleDisconnect(reason));

        this.client.on('change_state', (state) => {
            logger.info('Changement état', { state });
        });

        this.client.on('change_battery', (batteryInfo) => {
            logger.debug('Batterie', batteryInfo);
        });
    }

    handleQR(qr) {
        logger.info('NOUVEAU QR CODE GÉNÉRÉ');
        qrcode.generate(qr, { small: true });
        
        // Sauvegarder pour l'interface web
        const qrDir = path.join(__dirname, 'public');
        if (!fsSync.existsSync(qrDir)) {
            fsSync.mkdirSync(qrDir, { recursive: true });
        }
        
        require('qrcode').toFile(path.join(qrDir, 'qr.png'), qr, (err) => {
            if (err) logger.error('Erreur sauvegarde QR', { error: err.message });
        });
        
        this.reconnectAttempts = 0;
    }

    async handleReady() {
        logger.info('✅ WhatsApp connecté avec succès !');
        this.isReady = true;
        this.reconnectAttempts = 0;
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        this.startKeepAlive();
        
        try {
            this.clientInfo = this.client.info;
            logger.info('Connecté en tant que', { 
                pushname: this.clientInfo.pushname,
                number: this.clientInfo.me.user 
            });
            
            // Notifier Laravel sans bloquer
            this.notifyLaravel('connected', {
                phone: this.clientInfo.me.user,
                pushname: this.clientInfo.pushname
            }).catch(() => {});
            
        } catch (error) {
            logger.error('Erreur récupération infos', { error: error.message });
        }
    }

    async handleMessage(message) {
        this.messageCount++;
        
        logger.info('Message reçu', { 
            from: message.from, 
            body: message.body.substring(0, 50),
            type: message.type
        });
        
        // Mettre en queue pour éviter le blocage
        await messageQueue.add(message, async (msg) => {
            try {
                await this.notifyLaravel('message', {
                    from: msg.from,
                    body: msg.body,
                    timestamp: msg.timestamp,
                    type: msg.type,
                    hasMedia: msg.hasMedia
                });
                
                // Réponse automatique intelligente
                if (this.shouldAutoReply(msg)) {
                    await this.sendAutoReply(msg);
                }
            } catch (error) {
                logger.error('Erreur traitement message', { error: error.message });
            }
        });
    }

    shouldAutoReply(message) {
        const body = message.body.toLowerCase();
        return body.includes('signature') || 
               body.includes('engagement') ||
               body.includes('code') ||
               body.includes('vérification');
    }

    async sendAutoReply(message) {
        const body = message.body.toLowerCase();
        let reply = '';
        
        if (body.includes('signature') || body.includes('engagement')) {
            reply = '📝 Votre demande de signature a été reçue. Vous recevrez un lien sous peu.';
        } else if (body.includes('code') || body.includes('vérification')) {
            reply = '🔐 Un code de vérification va vous être envoyé. Veuillez patienter.';
        }
        
        if (reply) {
            await message.reply(reply);
            logger.info('Réponse automatique envoyée');
        }
    }

    async notifyLaravel(type, data) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeout);
        
        try {
            await axios.post(`${config.laravelApiUrl}/whatsapp/${type}`, {
                ...data,
                timestamp: new Date().toISOString()
            }, {
                headers: { 'Authorization': `Bearer ${config.apiToken}` },
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.warn('Timeout notification Laravel', { type });
            } else {
                logger.error('Erreur notification Laravel', { type, error: error.message });
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    handleDisconnect(reason) {
        logger.error('WhatsApp déconnecté', { reason });
        this.isReady = false;
        
        this.stopKeepAlive();
        
        // Notifier Laravel sans bloquer
        this.notifyLaravel('status', {
            status: 'disconnected',
            reason: reason
        }).catch(() => {});
        
        this.scheduleReconnect();
    }

    startKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        this.keepAliveInterval = setInterval(() => {
            if (this.isReady && this.client) {
                // Ping léger
                this.client.pupPage?.evaluate('1+1').catch(() => {});
                
                // Vérifier la mémoire
                checkMemory();
                
                logger.debug('Keep-alive ping');
            }
        }, config.keepAliveInterval);
        
        logger.info('Keep-alive activé', { interval: config.keepAliveInterval });
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.info('Keep-alive arrêté');
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        
        if (this.reconnectAttempts >= config.maxReconnectAttempts) {
            logger.error('Maximum tentatives reconnexion atteint');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(
            config.reconnectInterval * this.reconnectAttempts,
            60000
        );
        
        logger.info('Reconnexion planifiée', { 
            attempt: this.reconnectAttempts,
            max: config.maxReconnectAttempts,
            delay 
        });
        
        this.reconnectTimeout = setTimeout(async () => {
            logger.info('Tentative de reconnexion...');
            
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (error) {
                    logger.error('Erreur destruction client', { error: error.message });
                }
            }
            
            await this.initialize();
        }, delay);
    }

    getStats() {
        const mem = process.memoryUsage();
        return {
            uptime: Date.now() - this.startTime,
            isReady: this.isReady,
            reconnectAttempts: this.reconnectAttempts,
            messageCount: this.messageCount,
            memory: {
                heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                rss: Math.round(mem.rss / 1024 / 1024)
            },
            clientInfo: this.clientInfo
        };
    }
}

// ============================================
// INITIALISATION
// ============================================
const app = express();
const server = http.createServer(app);
const whatsapp = new WhatsAppClient();

// Middlewares de sécurité
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(async (req, res, next) => {
    try {
        await rateLimiter.consume(req.ip);
        next();
    } catch {
        res.status(429).json({ error: 'Trop de requêtes' });
    }
});

// Auth middleware
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.apiToken) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
};

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ...whatsapp.getStats(),
        timestamp: new Date().toISOString()
    });
});

// Statut
app.get('/api/status', authenticate, (req, res) => {
    res.json(whatsapp.getStats());
});

// Envoyer message
app.post('/api/send-message', authenticate, async (req, res) => {
    const { to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!whatsapp.isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const response = await whatsapp.client.sendMessage(chatId, message);
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        logger.error('Erreur envoi message', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Envoyer signature
app.post('/api/send-signature', authenticate, async (req, res) => {
    const { to, doctorName, signatureUrl } = req.body;
    
    if (!to || !doctorName || !signatureUrl) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!whatsapp.isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        
        const message = `📩 *7G Connect - Engagement sur l'honneur*\n\n` +
            `Bonjour Dr. ${doctorName},\n\n` +
            `Pour finaliser votre inscription et signer numériquement votre engagement, veuillez cliquer sur le lien ci-dessous :\n\n` +
            `${signatureUrl}\n\n` +
            `Ce lien est personnel et expirera dans 24 heures.\n\n` +
            `Cordialement,\n` +
            `L'équipe 7G Connect`;
        
        const response = await whatsapp.client.sendMessage(chatId, message);
        
        logger.info('Signature envoyée', { doctorName, to });
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        logger.error('Erreur envoi signature', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Envoyer code vérification
app.post('/api/send-verification', authenticate, async (req, res) => {
    const { to, code } = req.body;
    
    if (!to || !code) {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    if (!whatsapp.isReady) {
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    }
    
    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        
        const message = `🔐 *Code de vérification 7G Connect*\n\n` +
            `Votre code de vérification est : *${code}*\n\n` +
            `Ce code est valable 10 minutes. Ne le partagez avec personne.\n\n` +
            `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`;
        
        const response = await whatsapp.client.sendMessage(chatId, message);
        
        res.json({
            success: true,
            messageId: response.id._serialized,
            timestamp: response.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reconnexion forcée
app.post('/api/reconnect', authenticate, async (req, res) => {
    try {
        logger.info('Reconnexion forcée demandée');
        
        if (whatsapp.client) {
            await whatsapp.client.destroy();
        }
        
        whatsapp.initialize().catch(logger.error);
        
        res.json({
            success: true,
            message: 'Reconnexion initiée',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// INTERFACE WEB
// ============================================
app.get('/', (req, res) => {
    const stats = whatsapp.getStats();
    const qrExists = fsSync.existsSync(path.join(__dirname, 'public', 'qr.png'));
    
    const hours = Math.floor(stats.uptime / 3600000);
    const minutes = Math.floor((stats.uptime % 3600000) / 60000);
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>7G Connect - WhatsApp Service</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="30">
            <style>
                body {
                    font-family: system-ui, -apple-system, sans-serif;
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
                .status.disconnected { background: #ef4444; }
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
                    text-align: left;
                }
                .stats {
                    display: flex;
                    justify-content: center;
                    gap: 20px;
                    margin: 20px 0;
                    flex-wrap: wrap;
                }
                .stat-item {
                    background: rgba(255,255,255,0.1);
                    padding: 10px 15px;
                    border-radius: 10px;
                    min-width: 80px;
                }
                .stat-value {
                    font-size: 20px;
                    font-weight: 700;
                }
                .stat-label {
                    font-size: 11px;
                    opacity: 0.8;
                }
                .footer {
                    margin-top: 20px;
                    font-size: 12px;
                    opacity: 0.7;
                }
                .memory-bar {
                    background: rgba(255,255,255,0.2);
                    height: 10px;
                    border-radius: 5px;
                    margin: 10px 0;
                }
                .memory-fill {
                    background: #10b981;
                    height: 10px;
                    border-radius: 5px;
                    width: ${Math.min(100, (stats.memory.rss / 512) * 100)}%;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 7G Connect</h1>
                <p>Service WhatsApp professionnel v2.0</p>
                
                <div class="stats">
                    <div class="stat-item">
                        <div class="stat-value">${stats.isReady ? '✅' : stats.reconnectAttempts > 0 ? '🔄' : '⏳'}</div>
                        <div class="stat-label">Statut</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${hours}h ${minutes}m</div>
                        <div class="stat-label">Uptime</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${stats.messageCount}</div>
                        <div class="stat-label">Messages</div>
                    </div>
                </div>
                
                <div class="status ${stats.isReady ? 'connected' : stats.reconnectAttempts > 0 ? 'disconnected' : 'waiting'}">
                    ${stats.isReady ? '✅ Connecté' : stats.reconnectAttempts > 0 ? '🔄 Reconnexion...' : '⏳ En attente de scan'}
                </div>
                
                ${!stats.isReady && qrExists ? `
                <div class="qr-container">
                    <img src="/qr.png?${Date.now()}" alt="QR Code">
                </div>
                ` : ''}
                
                ${stats.clientInfo ? `
                <div class="info">
                    <p><strong>📱 Connecté en tant que:</strong><br>
                    ${stats.clientInfo.pushname} (${stats.clientInfo.me.user})</p>
                </div>
                ` : ''}
                
                <div class="info">
                    <p><strong>💾 Mémoire</strong></p>
                    <div class="memory-bar">
                        <div class="memory-fill"></div>
                    </div>
                    <p style="font-size: 12px; text-align: center;">
                        RSS: ${stats.memory.rss}MB / Heap: ${stats.memory.heapUsed}MB
                    </p>
                </div>
                
                <div class="info">
                    <p><strong>🔄 Reconnexion</strong></p>
                    <p>Tentative ${stats.reconnectAttempts}/${config.maxReconnectAttempts}</p>
                </div>
                
                <div class="info">
                    <p><strong>🔌 API Endpoints</strong></p>
                    <p style="font-size: 12px; text-align: left;">
                    • GET  /health<br>
                    • GET  /api/status<br>
                    • POST /api/send-message<br>
                    • POST /api/send-signature<br>
                    • POST /api/send-verification<br>
                    • POST /api/reconnect
                    </p>
                </div>
                
                <div class="footer">
                    Token: ${config.apiToken.substring(0, 8)}...<br>
                    7G Connect © ${new Date().getFullYear()}
                </div>
            </div>
        </body>
        </html>
    `);
});

// Fichiers statiques
app.use(express.static('public'));

// ============================================
// DÉMARRAGE
// ============================================
server.listen(config.port, () => {
    logger.info('Serveur démarré', { 
        port: config.port,
        token: config.apiToken.substring(0, 8) + '...',
        keepAlive: config.keepAliveInterval / 1000 + 's'
    });
    
    whatsapp.initialize().catch(logger.error);
});

// Gestion arrêt propre
async function shutdown(signal) {
    logger.info('Arrêt du service', { signal });
    
    whatsapp.stopKeepAlive();
    
    if (whatsapp.client) {
        await whatsapp.client.destroy();
    }
    
    server.close(() => {
        logger.info('Serveur arrêté');
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Gestion erreurs non capturées
process.on('uncaughtException', (error) => {
    logger.error('Exception non capturée', { error: error.message, stack: error.stack });
    checkMemory(); // Vérifier si c'est un problème mémoire
});

process.on('unhandledRejection', (error) => {
    logger.error('Rejet non géré', { error: error.message });
});

logger.info('Service WhatsApp 7G Connect démarré');