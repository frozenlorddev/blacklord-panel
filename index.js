// ============================================================
//   BLACKLORD TECH – REAL PANEL BACKEND
//   ============================================================
'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html from root

// ─── CONFIG ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const PORT = process.env.PORT || 3002;

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY;

const PANEL_DOMAIN = process.env.PANEL_DOMAIN;
const PANEL_APIKEY = process.env.PANEL_APIKEY;
const PANEL_EGG   = parseInt(process.env.PANEL_EGG) || 15;
const PANEL_NEST  = parseInt(process.env.PANEL_NEST) || 5;
const PANEL_LOC   = parseInt(process.env.PANEL_LOC) || 1;

// ─── DATABASE ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'database.json');

let db = {
    users: {},
    prices: {
        panel: { '1gb': 1000, '2gb': 2000, '3gb': 3000, '4gb': 4000, 'unlimited': 8000 },
        vps: { '1gb': 5000, '2gb': 10000, '4gb': 20000, '8gb': 40000 },
        currency: 'KES',
    },
};

function loadDb() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            db = { ...db, ...data };
        }
    } catch (e) { console.error('Failed to load database:', e.message); }
}
function saveDb() {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) { console.error('Failed to save:', e.message); }
}
loadDb();

// ─── HELPERS ────────────────────────────────────────────────
function generateReferralCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generatePassword(username) {
    const first = username.charAt(0).toUpperCase();
    const rest = username.slice(1).toLowerCase();
    const digits = String(Math.floor(Math.random() * 90 + 10));
    return first + rest + digits + '!';
}

function getRam(ramKey) {
    const map = { '1gb': 1024, '2gb': 2048, '3gb': 3072, '4gb': 4096, 'unlimited': 0 };
    return map[ramKey] || 2048;
}

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = auth.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── PAYSTACK HELPERS ──────────────────────────────────────
async function initPaystackPayment(amount, email, reference, metadata = {}) {
    try {
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                amount: amount * 100,
                email: email || 'user@example.com',
                reference: reference || `PAY-${Date.now()}`,
                metadata: metadata,
                callback_url: process.env.PAYSTACK_CALLBACK_URL || '',
            },
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
                timeout: 10000,
            }
        );
        return response.data;
    } catch (err) {
        console.error('Paystack init error:', err.response?.data || err.message);
        return null;
    }
}

async function verifyPaystackPayment(reference) {
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
                timeout: 10000,
            }
        );
        return response.data;
    } catch (err) {
        console.error('Paystack verify error:', err.response?.data || err.message);
        return null;
    }
}

// ─── PTERODACTYL PANEL CREATION ──────────────────────────────
async function findPterodactylUser(username) {
    try {
        const response = await axios.get(
            `${PANEL_DOMAIN}/api/application/users?filter[email]=${username}@gmail.com`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 10000,
            }
        );
        const users = response.data.data;
        if (users && users.length > 0) {
            return users[0].attributes.id;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function createPterodactylPanel(username, ramMB, diskMB, cpuPercent, isAdmin = false) {
    let existingUserId = await findPterodactylUser(username);
    let userId, userPassword = null;

    if (existingUserId) {
        userId = existingUserId;
    } else {
        userPassword = generatePassword(username);
        try {
            const userRes = await axios.post(
                `${PANEL_DOMAIN}/api/application/users`,
                {
                    email: `${username}@gmail.com`,
                    username: username,
                    first_name: username,
                    last_name: isAdmin ? 'Admin' : 'Panel',
                    root_admin: isAdmin,
                    language: 'en',
                    password: userPassword,
                },
                {
                    headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' },
                    timeout: 15000,
                }
            );
            userId = userRes.data.attributes.id;
        } catch (e) {
            throw new Error(`User creation failed: ${e.response?.data?.errors?.[0]?.detail || e.message}`);
        }
    }

    let allocId;
    try {
        const allocRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nodes/${PANEL_LOC}/allocations`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        const alloc = allocRes.data.data.find(a => a.attributes.assigned === false);
        if (!alloc) throw new Error('No available port');
        allocId = alloc.attributes.id;
    } catch (e) {
        throw new Error(`Allocation error: ${e.message}`);
    }

    let eggDetails;
    try {
        const eggRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        eggDetails = eggRes.data.attributes;
    } catch (e) {
        throw new Error(`Failed to fetch egg details: ${e.message}`);
    }

    const environment = {};
    if (eggDetails.relationships && eggDetails.relationships.variables && eggDetails.relationships.variables.data) {
        for (const varData of eggDetails.relationships.variables.data) {
            const varAttr = varData.attributes || varData;
            const key = varAttr.env_variable;
            if (key) {
                environment[key] = varAttr.default_value || '';
            }
        }
    }
    environment.NODE_VERSION = '18';
    environment.INST = 'npm';
    environment.CMD_RUN = 'npm start';

    try {
        const serverData = {
            name: `${username}-${isAdmin ? 'admin' : 'panel'}-${Date.now().toString().slice(-4)}`,
            user: userId,
            egg: PANEL_EGG,
            docker_image: eggDetails.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
            startup: eggDetails.startup || 'npm start',
            environment: environment,
            skip_scripts: false,
            limits: { memory: ramMB, swap: 0, disk: diskMB, io: 500, cpu: cpuPercent },
            feature_limits: { databases: 1, backups: 1 },
            allocation: { default: allocId },
            deployment: { locations: [PANEL_LOC] },
            start_on_completion: true,
        };

        const srvRes = await axios.post(
            `${PANEL_DOMAIN}/api/application/servers`,
            serverData,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            }
        );

        return {
            username: username,
            password: existingUserId ? null : userPassword,
            domain: PANEL_DOMAIN,
            serverId: srvRes.data.attributes.id,
            reused: !!existingUserId,
        };
    } catch (e) {
        const errorMsg = e.response?.data?.errors?.[0]?.detail || e.message;
        throw new Error(`Server creation failed: ${errorMsg}`);
    }
}

const pendingPayments = new Map();

// ─── API ENDPOINTS ──────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const existing = Object.values(db.users).find(u => u.email === email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = `user_${Date.now()}`;
    db.users[userId] = {
        email,
        firstName,
        lastName,
        passwordHash: hashed,
        sdBalance: 50,
        panels: [],
        bots: [],
        referralsCount: 0,
        referralCode: generateReferralCode(),
        registeredAt: new Date().toISOString(),
    };
    saveDb();
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email, firstName, lastName, sdBalance: 50, totalServers: 0 } });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const userEntry = Object.entries(db.users).find(([id, u]) => u.email === email);
    if (!userEntry) return res.status(401).json({ error: 'Invalid credentials' });
    const userId = userEntry[0];
    const user = userEntry[1];
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        sdBalance: user.sdBalance || 0,
        totalServers: (user.panels || []).length + (user.bots || []).length,
        activeServers: (user.panels || []).filter(p => p.status === 'active').length +
                       (user.bots || []).filter(b => b.status === 'active').length,
        referralsCount: user.referralsCount || 0,
    }});
});

app.get('/api/me', authMiddleware, async (req, res) => {
    const user = db.users[req.userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({
        user: {
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            sdBalance: user.sdBalance || 0,
            totalServers: (user.panels || []).length + (user.bots || []).length,
            activeServers: (user.panels || []).filter(p => p.status === 'active').length +
                           (user.bots || []).filter(b => b.status === 'active').length,
            referralsCount: user.referralsCount || 0,
            panels: user.panels || [],
            bots: user.bots || [],
        }
    });
});

app.get('/api/products', (req, res) => {
    const panels = Object.keys(db.prices.panel).map(key => ({
        type: 'panel', id: key,
        name: key.toUpperCase() + ' Panel',
        ram: key === 'unlimited' ? 'Unlimited' : key + 'GB',
        price: db.prices.panel[key],
        currency: db.prices.currency,
    }));
    const adminPlans = [
        { type: 'admin', id: 'admin-std', name: 'Standard Admin', price: 1500, currency: 'KES' },
        { type: 'admin', id: 'admin-pro', name: 'Pro Admin', price: 2500, currency: 'KES' },
        { type: 'admin', id: 'admin-enterprise', name: 'Enterprise Admin', price: 5000, currency: 'KES' },
    ];
    res.json({ panels, admin: adminPlans });
});

app.post('/api/topup', authMiddleware, async (req, res) => {
    const { amountKsh } = req.body;
    if (!amountKsh || amountKsh <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const sdAmount = Math.round(amountKsh / 1.6);
    if (sdAmount <= 0) return res.status(400).json({ error: 'Amount too small' });

    const reference = `TOPUP-${userId}-${Date.now()}`;
    const email = user.email || 'user@example.com';

    const init = await initPaystackPayment(amountKsh, email, reference, {
        type: 'topup',
        userId: userId,
        sdAmount: sdAmount,
        amountKsh: amountKsh,
    });

    if (!init || !init.status) return res.status(500).json({ error: 'Payment initiation failed' });

    pendingPayments.set(reference, {
        userId: userId,
        type: 'topup',
        sdAmount: sdAmount,
        amountKsh: amountKsh,
        status: 'pending',
    });

    res.json({ reference, authorization_url: init.data.authorization_url });
});

app.get('/api/verify-payment', async (req, res) => {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const verify = await verifyPaystackPayment(reference);
    if (!verify || !verify.status || verify.data.status !== 'success') {
        return res.status(400).json({ error: 'Payment not successful' });
    }

    const metadata = verify.data.metadata || {};
    const pending = pendingPayments.get(reference);

    if (metadata.type === 'topup' || pending?.type === 'topup') {
        const userId = metadata.userId || pending?.userId;
        const sdAmount = parseFloat(metadata.sdAmount || pending?.sdAmount || 0);
        if (userId && sdAmount > 0) {
            const user = db.users[userId];
            if (user) {
                user.sdBalance = (user.sdBalance || 0) + sdAmount;
                saveDb();
                pendingPayments.delete(reference);
                return res.json({
                    success: true,
                    message: `✅ Added ${sdAmount} SD to your balance!`,
                    sdBalance: user.sdBalance,
                });
            }
        }
        pendingPayments.delete(reference);
        return res.json({ success: true, message: 'Top-up processed.' });
    }

    pendingPayments.delete(reference);
    res.json({ success: true, message: 'Payment verified.' });
});

app.post('/api/buy', authMiddleware, async (req, res) => {
    const { productType, productId, username, password: userPassword } = req.body;
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    let sdPrice = 0;
    let productDetails = {};
    const sdToKsh = 1.6;

    if (productType === 'panel') {
        const ram = productId;
        const kshPrice = db.prices.panel[ram];
        if (!kshPrice) return res.status(400).json({ error: 'Invalid panel plan' });
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { ram, username, isAdmin: false };
    } else if (productType === 'admin') {
        const adminPriceMap = { 'admin-std': 1500, 'admin-pro': 2500, 'admin-enterprise': 5000 };
        const kshPrice = adminPriceMap[productId];
        if (!kshPrice) return res.status(400).json({ error: 'Invalid admin plan' });
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { ram: 1024, username, isAdmin: true };
    } else {
        return res.status(400).json({ error: 'Invalid product type' });
    }

    if (sdPrice <= 0) return res.status(400).json({ error: 'Price not configured' });

    if ((user.sdBalance || 0) < sdPrice) {
        return res.status(402).json({
            error: 'Insufficient SD balance',
            sdBalance: user.sdBalance || 0,
            sdRequired: sdPrice,
            kshRequired: Math.round(sdPrice * sdToKsh),
        });
    }

    user.sdBalance -= sdPrice;
    saveDb();

    try {
        const ramMB = productDetails.ram || getRam(productDetails.ram);
        const diskMB = ramMB * 2;
        const cpuPercent = productDetails.isAdmin ? 60 : 40;

        const panelResult = await createPterodactylPanel(
            username,
            ramMB,
            diskMB,
            cpuPercent,
            productDetails.isAdmin
        );

        const panelRecord = {
            username: username,
            password: panelResult.password || userPassword || generatePassword(username),
            domain: panelResult.domain,
            plan: productDetails.ram || productId,
            sdPrice: sdPrice,
            status: 'active',
            type: productDetails.isAdmin ? 'admin' : 'panel',
            serverId: panelResult.serverId,
            reused: panelResult.reused,
            createdAt: new Date().toISOString(),
        };
        if (!user.panels) user.panels = [];
        user.panels.push(panelRecord);
        saveDb();

        res.json({
            success: true,
            panel: {
                username: panelRecord.username,
                password: panelRecord.password,
                domain: panelRecord.domain,
                plan: panelRecord.plan,
                status: panelRecord.status,
                reused: panelRecord.reused,
            }
        });
    } catch (error) {
        user.sdBalance += sdPrice;
        saveDb();
        console.error('Panel creation error:', error.message);
        res.status(500).json({ error: 'Panel creation failed: ' + error.message });
    }
});

app.post('/api/toggle-panel', authMiddleware, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const panel = user.panels.find(p => p.username === username);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    panel.status = panel.status === 'active' ? 'inactive' : 'active';
    saveDb();
    res.json({ success: true, status: panel.status });
});

app.post('/api/delete-panel', authMiddleware, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const index = user.panels.findIndex(p => p.username === username);
    if (index === -1) return res.status(404).json({ error: 'Panel not found' });
    user.panels.splice(index, 1);
    saveDb();
    res.json({ success: true });
});

app.post('/api/deploy-bot', authMiddleware, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Bot name required' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const bot = {
        name,
        type: 'Samsung XMD',
        token: Math.random().toString(36).substring(2, 10) + ':' + Math.random().toString(36).substring(2, 14),
        status: 'active',
        createdAt: new Date().toISOString(),
    };
    if (!user.bots) user.bots = [];
    user.bots.push(bot);
    saveDb();
    res.json({ success: true, bot });
});

app.post('/api/toggle-bot', authMiddleware, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const bot = user.bots.find(b => b.token === token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.status = bot.status === 'active' ? 'inactive' : 'active';
    saveDb();
    res.json({ success: true, status: bot.status });
});

app.post('/api/delete-bot', authMiddleware, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const index = user.bots.findIndex(b => b.token === token);
    if (index === -1) return res.status(404).json({ error: 'Bot not found' });
    user.bots.splice(index, 1);
    saveDb();
    res.json({ success: true });
});

// ─── SERVE FRONTEND ──────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START SERVER ────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📍 Open http://localhost:${PORT} in your browser`);
    if (!PANEL_DOMAIN || !PANEL_APIKEY) {
        console.warn('⚠️  PANEL_DOMAIN or PANEL_APIKEY not set. Panel creation will fail.');
    }
});