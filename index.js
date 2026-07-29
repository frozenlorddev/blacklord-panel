// ============================================================
//   BLACKLORD TECH – COMPLETE SYSTEM (One File – No .env)
//   ============================================================
'use strict';

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

// ─── CONFIG (HARDCODED) ──────────────────────────────────────
const PORT = 3002;
const JWT_SECRET = 'your-super-secret-key-change-me-in-production';

// ─── PAYSTACK (TEST KEYS) ────────────────────────────────────
const PAYSTACK_SECRET = 'sk_test_061c255581146664ed28fa5e1ac3c808e3103c4f';
const PAYSTACK_PUBLIC = 'pk_test_6bdd15abf5fe31d1b38ea32699a533a383efc9dc';
const PAYSTACK_CALLBACK_URL = 'http://localhost:3002';

// ─── PTERODACTYL PANEL (REPLACE WITH YOUR REAL VALUES) ──────
const PANEL_DOMAIN = 'https://panel.yourdomain.com'; // CHANGE THIS
const PANEL_APIKEY = 'ptla_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // CHANGE THIS
const PANEL_EGG = 15;
const PANEL_NEST = 5;
const PANEL_LOC = 1;

// ─── DATABASE ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'database.json');

let db = {
    users: {},
    prices: {
        panel: { '1gb': 1000, '2gb': 2000, '3gb': 3000, '4gb': 4000, 'unlimited': 8000 },
        vps: { '1gb': 5000, '2gb': 10000, '4gb': 20000, '8gb': 40000 },
        currency: 'KES',
    },
    fileStore: [],
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
                callback_url: PAYSTACK_CALLBACK_URL,
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
async function createPterodactylPanel(username, ramMB, diskMB, cpuPercent, isAdmin = false) {
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
                password: generatePassword(username),
            },
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' },
                timeout: 15000,
            }
        );
        const userId = userRes.data.attributes.id;

        const allocRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nodes/${PANEL_LOC}/allocations`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        const alloc = allocRes.data.data.find(a => a.attributes.assigned === false);
        if (!alloc) throw new Error('No available port');
        const allocId = alloc.attributes.id;

        const eggRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        const eggDetails = eggRes.data.attributes;

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
            password: generatePassword(username),
            domain: PANEL_DOMAIN,
            serverId: srvRes.data.attributes.id,
        };
    } catch (e) {
        const errorMsg = e.response?.data?.errors?.[0]?.detail || e.message;
        throw new Error(`Panel creation failed: ${errorMsg}`);
    }
}

async function createVPS(username, ram) {
    // Placeholder – replace with real DigitalOcean call if you have DO_API_KEY
    return {
        ip: '192.168.1.100',
        password: generatePassword(username),
        dropletId: '12345678',
    };
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
        sdBalance: 0,
        panels: [],
        vps: [],
        referralsCount: 0,
        referralCode: generateReferralCode(),
        registeredAt: new Date().toISOString(),
    };
    saveDb();
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email, firstName, lastName, sdBalance: 0, totalPanels: 0 } });
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
        totalPanels: (user.panels || []).length,
        activePanels: (user.panels || []).filter(p => p.status !== 'suspended').length,
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
            totalPanels: (user.panels || []).length,
            activePanels: (user.panels || []).filter(p => p.status !== 'suspended').length,
            orders: (user.panels || []).length + (user.vps || []).length,
            referralsCount: user.referralsCount || 0,
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
    const vps = Object.keys(db.prices.vps).map(key => ({
        type: 'vps', id: key,
        name: key.toUpperCase() + ' VPS',
        ram: key + 'GB',
        price: db.prices.vps[key],
        currency: db.prices.currency,
    }));
    const files = (db.fileStore || []).map(f => ({
        type: 'file', id: f.fileId,
        name: f.name,
        description: f.description || '',
        price: f.price || 500,
        currency: db.prices.currency || 'KES',
    }));
    res.json({ panels, vps, files });
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
    const { productType, productId, username } = req.body;
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
        productDetails = { ram, username };
    } else if (productType === 'vps') {
        const ram = productId;
        const kshPrice = db.prices.vps[ram];
        if (!kshPrice) return res.status(400).json({ error: 'Invalid VPS plan' });
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { ram, username };
    } else if (productType === 'file') {
        const file = db.fileStore.find(f => f.fileId === productId);
        if (!file) return res.status(400).json({ error: 'File not found' });
        const kshPrice = file.price || 500;
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { fileId: productId, fileName: file.name };
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

    let result = { success: true };

    try {
        if (productType === 'panel') {
            const panel = await createPterodactylPanel(
                username,
                getRam(productDetails.ram),
                1024,
                40,
                false
            );
            result.panel = panel;
            if (!user.panels) user.panels = [];
            user.panels.push({
                type: 'PANEL',
                username: username,
                ram: productDetails.ram,
                createdAt: new Date().toISOString(),
                credentials: panel,
            });
            saveDb();
        } else if (productType === 'vps') {
            const vps = await createVPS(username, productDetails.ram);
            result.vps = vps;
            if (!user.vps) user.vps = [];
            user.vps.push({
                type: 'VPS',
                username: username,
                ram: productDetails.ram,
                createdAt: new Date().toISOString(),
                credentials: vps,
            });
            saveDb();
        } else if (productType === 'file') {
            const file = db.fileStore.find(f => f.fileId === productDetails.fileId);
            result.file = { name: file?.name || 'File', fileId: productDetails.fileId };
        }

        res.json(result);
    } catch (err) {
        user.sdBalance += sdPrice;
        saveDb();
        res.status(500).json({ error: 'Product creation failed: ' + err.message });
    }
});

app.get('/api/activity', authMiddleware, async (req, res) => {
    const user = db.users[req.userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const activities = [];
    if (user.panels) {
        user.panels.forEach(p => {
            activities.push({
                type: 'panel',
                desc: `Panel Deployed: ${p.username}`,
                amount: -1250,
                date: new Date(p.createdAt).toLocaleDateString(),
            });
        });
    }
    if (user.vps) {
        user.vps.forEach(v => {
            activities.push({
                type: 'vps',
                desc: `VPS Deployed: ${v.username}`,
                amount: -2500,
                date: new Date(v.createdAt).toLocaleDateString(),
            });
        });
    }
    if (user.referralsCount > 0) {
        activities.push({
            type: 'referral',
            desc: `Referral Bonus (${user.referralsCount} referrals)`,
            amount: user.referralsCount * 5,
            date: new Date().toLocaleDateString(),
        });
    }
    if (activities.length === 0) {
        return res.json({ activities: [
            { type: 'panel', desc: 'Panel Deployed: myvps', amount: -1250, date: '17 Jun 2026' },
            { type: 'topup', desc: 'SD Top-up', amount: 50, date: '16 Jun 2026' },
            { type: 'referral', desc: 'Referral Bonus', amount: 5, date: '15 Jun 2026' },
        ]});
    }

    activities.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ activities: activities.slice(0, 10) });
});

// ─── SERVE FRONTEND (HTML embedded) ──────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>𝐁𝐋𝐀𝐂𝐊𝐋𝐎𝐑𝐃 𝐓𝐄𝐂𝐇 𝐈𝐍𝐂</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #0b0b14;
            color: #eee;
            min-height: 100vh;
        }
        .bg-overlay {
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background-image: url('https://i.ibb.co/prBSVCjv/dec3fe2b0949.jpg');
            background-size: cover; background-position: center; background-repeat: no-repeat;
            opacity: 0.25; z-index: 0; pointer-events: none;
        }
        .app {
            position: relative; z-index: 1;
            max-width: 1200px; margin: 0 auto; padding: 20px;
            min-height: 100vh;
            display: flex; flex-direction: column;
        }
        nav {
            display: flex; justify-content: space-between; align-items: center;
            padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.08);
            margin-bottom: 30px;
            flex-wrap: wrap;
            gap: 15px;
        }
        .logo {
            font-size: 1.6rem; font-weight: bold;
            background: linear-gradient(135deg, #ffd700, #ff6b00);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            cursor: pointer;
        }
        .menu-toggle {
            display: none;
            flex-direction: column;
            gap: 5px;
            cursor: pointer;
            background: none;
            border: none;
            padding: 8px;
        }
        .menu-toggle span {
            display: block;
            width: 28px;
            height: 3px;
            background: #eee;
            border-radius: 4px;
            transition: 0.3s;
        }
        .menu-toggle.active span:nth-child(1) { transform: rotate(45deg) translate(6px, 6px); }
        .menu-toggle.active span:nth-child(2) { opacity: 0; }
        .menu-toggle.active span:nth-child(3) { transform: rotate(-45deg) translate(6px, -6px); }
        .nav-links {
            display: flex; align-items: center; gap: 8px;
            flex-wrap: wrap; transition: 0.3s ease;
        }
        .nav-links a, .nav-links .nav-btn {
            color: #ccc; text-decoration: none; padding: 8px 16px;
            border-radius: 30px; font-size: 0.95rem; font-weight: 500;
            transition: 0.2s; background: transparent; border: none; cursor: pointer;
        }
        .nav-links a:hover, .nav-links .nav-btn:hover {
            color: #ffd700; background: rgba(255,215,0,0.08);
        }
        .nav-links .btn-outline { border: 1px solid #ffd700; color: #ffd700; }
        .nav-links .btn-outline:hover { background: #ffd700; color: #0b0b14; }
        .nav-links .btn-primary {
            background: #ffd700; color: #0b0b14; font-weight: bold; padding: 8px 22px;
        }
        .nav-links .btn-primary:hover { background: #ffed4a; }
        .balance-badge {
            background: rgba(255,215,0,0.12);
            border: 1px solid rgba(255,215,0,0.2);
            padding: 6px 18px;
            border-radius: 30px;
            color: #ffd700;
            font-weight: 600;
            font-size: 0.9rem;
        }
        .hide { display: none !important; }
        .page { display: none; animation: fadeIn 0.3s ease; flex: 1; }
        .page.active { display: block; }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .hero {
            display: flex; flex-direction: column; justify-content: center;
            align-items: center; text-align: center; padding: 80px 20px 100px;
            flex: 1;
        }
        .hero h1 {
            font-size: 4rem; font-weight: 700; margin-bottom: 20px;
            background: linear-gradient(135deg, #ffd700, #ff6b00);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            line-height: 1.2;
        }
        .hero .subtitle {
            font-size: 1.3rem; color: #ccc; max-width: 700px;
            margin: 0 auto 40px; line-height: 1.8;
        }
        .hero .subtitle strong { color: #ffd700; }
        .cta a, .cta button {
            display: inline-block; background: #ffd700; color: #0b0b14;
            padding: 18px 60px; border-radius: 50px; font-size: 1.4rem;
            font-weight: 700; text-decoration: none; transition: 0.2s;
            border: none; cursor: pointer;
        }
        .cta a:hover, .cta button:hover { background: #ffed4a; transform: scale(1.05); }
        .form-container {
            max-width: 420px; margin: 40px auto;
            background: rgba(26,26,47,0.9); backdrop-filter: blur(12px);
            padding: 40px 30px; border-radius: 24px;
            border: 1px solid rgba(255,215,0,0.1);
        }
        .form-container h2 {
            text-align: center; font-size: 2rem; margin-bottom: 8px;
            background: linear-gradient(135deg, #ffd700, #ff6b00);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .form-container .sub { text-align: center; color: #888; margin-bottom: 25px; }
        .form-container label { display: block; margin: 14px 0 5px; font-size: 0.9rem; color: #ccc; }
        .form-container input {
            width: 100%; padding: 14px; border-radius: 12px; border: none;
            background: #2a2a3f; color: #eee; font-size: 1rem;
        }
        .form-container input:focus { outline: 2px solid #ffd700; }
        .form-container .btn-submit {
            width: 100%; padding: 14px; background: #ffd700; color: #0b0b14;
            border: none; border-radius: 30px; font-weight: bold; font-size: 1.1rem;
            cursor: pointer; margin-top: 25px; transition: 0.2s;
        }
        .form-container .btn-submit:hover { background: #ffed4a; transform: scale(1.02); }
        .form-footer { text-align: center; margin-top: 18px; color: #888; }
        .form-footer a { color: #ffd700; text-decoration: none; cursor: pointer; }
        .error-msg { color: #ff6b6b; margin: 10px 0; text-align: center; }
        .success-msg { color: #6bcb77; margin: 10px 0; text-align: center; }
        .welcome-row {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 25px; flex-wrap: wrap; gap: 15px;
        }
        .welcome-row h1 { font-size: 1.8rem; font-weight: 600; }
        .welcome-row h1 span { color: #ffd700; }
        .welcome-row .sub { color: #aaa; font-size: 0.95rem; }
        .balance-card {
            background: rgba(26,26,47,0.85); backdrop-filter: blur(12px);
            border-radius: 24px; padding: 30px 30px 25px;
            border: 1px solid rgba(255,215,0,0.12);
            margin-bottom: 30px;
            display: flex; justify-content: space-between; align-items: center;
            flex-wrap: wrap; gap: 20px;
        }
        .balance-left h2 {
            font-size: 0.85rem; text-transform: uppercase; letter-spacing: 2px;
            color: #888; font-weight: 400; margin-bottom: 8px;
        }
        .balance-left .amount {
            font-size: 2.8rem; font-weight: 700; color: #ffd700; line-height: 1.2;
        }
        .balance-left .amount small { font-size: 1.2rem; color: #aaa; font-weight: 400; margin-left: 8px; }
        .balance-left .ksh { font-size: 1.2rem; color: #ccc; margin-top: 4px; }
        .balance-left .change { font-size: 0.9rem; color: #ff6b6b; margin-top: 4px; }
        .balance-right { display: flex; gap: 12px; flex-wrap: wrap; }
        .balance-right button {
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
            color: #eee; padding: 10px 24px; border-radius: 30px;
            font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: 0.2s;
        }
        .balance-right button:hover { background: rgba(255,215,0,0.15); border-color: #ffd700; }
        .balance-right .btn-gold { background: #ffd700; color: #0b0b14; border: none; }
        .balance-right .btn-gold:hover { background: #ffed4a; }
        .stats-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr));
            gap: 18px; margin-bottom: 35px;
        }
        .stat-card {
            background: rgba(26,26,47,0.75); backdrop-filter: blur(8px);
            border-radius: 18px; padding: 20px 20px 18px;
            border: 1px solid rgba(255,255,255,0.05); transition: 0.2s;
        }
        .stat-card:hover { border-color: rgba(255,215,0,0.2); }
        .stat-card .label {
            font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px;
            color: #888; font-weight: 500;
        }
        .stat-card .value { font-size: 1.9rem; font-weight: 700; margin-top: 6px; color: #fff; }
        .stat-card .value.gold { color: #ffd700; }
        .stat-card .value.green { color: #6bcb77; }
        .stat-card .value.blue { color: #4d96ff; }
        .stat-card .sub-text { font-size: 0.8rem; color: #888; margin-top: 4px; }
        .offer-banner {
            background: linear-gradient(135deg, rgba(255,215,0,0.12), rgba(255,107,0,0.08));
            border: 1px solid rgba(255,215,0,0.15);
            border-radius: 16px; padding: 18px 25px;
            display: flex; justify-content: space-between; align-items: center;
            flex-wrap: wrap; gap: 15px; margin-bottom: 30px;
        }
        .offer-banner p { font-size: 0.95rem; color: #ddd; }
        .offer-banner p strong { color: #ffd700; }
        .offer-banner .btn-link {
            color: #ffd700; text-decoration: none; font-weight: 600;
            background: rgba(255,215,0,0.1); padding: 8px 24px; border-radius: 30px;
            transition: 0.2s; cursor: pointer;
        }
        .offer-banner .btn-link:hover { background: #ffd700; color: #0b0b14; }
        .two-col {
            display: grid; grid-template-columns: 2fr 1fr; gap: 25px; margin-bottom: 40px;
        }
        .quick-access, .recent-activity {
            background: rgba(26,26,47,0.75); backdrop-filter: blur(8px);
            border-radius: 20px; padding: 25px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .quick-access h3, .recent-activity h3 {
            font-size: 1rem; font-weight: 600; margin-bottom: 18px; color: #ddd;
        }
        .quick-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(120px,1fr));
            gap: 12px;
        }
        .quick-btn {
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
            border-radius: 14px; padding: 14px 10px; text-align: center;
            color: #ccc; text-decoration: none; font-size: 0.85rem; font-weight: 500;
            transition: 0.2s; cursor: pointer;
        }
        .quick-btn:hover { background: rgba(255,215,0,0.08); border-color: #ffd700; color: #fff; }
        .quick-btn .icon { display: block; font-size: 1.6rem; margin-bottom: 6px; }
        .quick-btn .badge {
            display: inline-block; background: #ffd700; color: #0b0b14;
            font-size: 0.6rem; padding: 1px 10px; border-radius: 12px; margin-top: 4px; font-weight: 700;
        }
        .activity-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .activity-item:last-child { border-bottom: none; }
        .activity-item .left { display: flex; align-items: center; gap: 12px; }
        .activity-item .dot {
            width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        .activity-item .dot.green { background: #6bcb77; }
        .activity-item .dot.gold { background: #ffd700; }
        .activity-item .dot.red { background: #ff6b6b; }
        .activity-item .dot.blue { background: #4d96ff; }
        .activity-item .desc { font-size: 0.9rem; color: #ddd; }
        .activity-item .desc small { color: #888; font-size: 0.75rem; display: block; margin-top: 2px; }
        .activity-item .amount { font-weight: 600; font-size: 0.95rem; }
        .activity-item .amount.positive { color: #6bcb77; }
        .activity-item .amount.negative { color: #ff6b6b; }
        .product-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(250px,1fr));
            gap: 20px; margin: 30px 0;
        }
        .product-card {
            background: rgba(26,26,47,0.85); backdrop-filter: blur(8px);
            border-radius: 20px; padding: 25px;
            border: 1px solid rgba(255,255,255,0.06); transition: 0.2s;
        }
        .product-card:hover { border-color: rgba(255,215,0,0.2); transform: translateY(-4px); }
        .product-card h3 { color: #ffd700; font-size: 1.3rem; }
        .product-card .price-sd { font-size: 2rem; color: #fff; font-weight: 700; margin: 10px 0; }
        .product-card .price-sd small { font-size: 1rem; color: #888; font-weight: 400; }
        .product-card .price-ksh { color: #888; font-size: 0.9rem; }
        .product-card button {
            background: #ffd700; color: #0b0b14; border: none; padding: 12px 20px;
            border-radius: 30px; font-weight: bold; cursor: pointer; width: 100%;
            transition: 0.2s; margin-top: 10px;
        }
        .product-card button:hover { background: #ffed4a; transform: scale(1.02); }
        .product-card button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
        .topup-section {
            background: rgba(26,26,47,0.85); backdrop-filter: blur(8px);
            border-radius: 20px; padding: 25px 30px;
            border: 1px solid rgba(255,215,0,0.1);
            margin-bottom: 30px;
            display: flex; justify-content: space-between; align-items: center;
            flex-wrap: wrap; gap: 15px;
        }
        .topup-section h2 { color: #ffd700; font-size: 1.3rem; }
        .topup-section p { color: #aaa; }
        .topup-buttons { display: flex; gap: 10px; flex-wrap: wrap; }
        .topup-buttons button {
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
            color: #eee; padding: 10px 24px; border-radius: 30px;
            cursor: pointer; transition: 0.2s; font-weight: 500;
        }
        .topup-buttons button:hover { background: rgba(255,215,0,0.12); border-color: #ffd700; }
        .topup-buttons .btn-gold { background: #ffd700; color: #0b0b14; border: none; }
        .topup-buttons .btn-gold:hover { background: #ffed4a; }
        .modal {
            display: none; position: fixed; top:0; left:0; width:100%; height:100%;
            background: rgba(0,0,0,0.7); justify-content:center; align-items:center; z-index:1000;
        }
        .modal.active { display: flex; }
        .modal-content {
            background: #1a1a2f; padding: 35px; border-radius: 24px;
            max-width: 420px; width: 90%; border: 1px solid rgba(255,215,0,0.1);
        }
        .modal-content h2 { color: #ffd700; margin-bottom: 15px; text-align:center; }
        .modal-content p { color: #aaa; text-align:center; margin-bottom:20px; }
        .modal-content input {
            width: 100%; padding: 12px; border-radius: 12px; border: none;
            background: #2a2a3f; color: #eee; font-size: 1rem; margin-bottom:15px;
        }
        .modal-content .btn-group { display: flex; gap: 12px; justify-content:center; }
        .modal-content .btn-group button { padding: 12px 30px; border: none; border-radius:30px; font-weight:bold; cursor:pointer; }
        .btn-confirm { background: #ffd700; color: #0b0b14; }
        .btn-cancel { background: #444; color: #fff; }
        .footer {
            text-align: center; color: #555; padding: 20px 0 10px;
            border-top: 1px solid rgba(255,255,255,0.05); font-size:0.85rem;
            margin-top:30px;
        }
        .footer span { color: #888; }
        .loading-text { color: #aaa; font-size:0.9rem; display:flex; align-items:center; gap:10px; }
        .loading {
            display:inline-block; width:20px; height:20px;
            border:2px solid rgba(255,215,0,0.2); border-top-color:#ffd700;
            border-radius:50%; animation:spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform:rotate(360deg); } }
        @media (max-width:768px) {
            .hero h1 { font-size:2.6rem; }
            .menu-toggle { display:flex; }
            .nav-links {
                display:none; flex-direction:column; align-items:stretch; width:100%;
                padding:15px 0; gap:5px; border-top:1px solid rgba(255,255,255,0.06);
            }
            .nav-links.open { display:flex; }
            .nav-links a, .nav-links .nav-btn { text-align:center; padding:12px; }
            .two-col { grid-template-columns:1fr; }
            .balance-left .amount { font-size:2rem; }
            .stats-grid { grid-template-columns:1fr 1fr; }
            .quick-grid { grid-template-columns:1fr 1fr; }
            .hero { padding:50px 20px 60px; }
            .hero .subtitle { font-size:1.1rem; }
            .cta a, .cta button { padding:14px 40px; font-size:1.1rem; }
        }
        @media (max-width:480px) {
            .hero h1 { font-size:2rem; }
            .hero .subtitle { font-size:1rem; }
            .stats-grid { grid-template-columns:1fr; }
            .quick-grid { grid-template-columns:1fr; }
            .cta a, .cta button { padding:12px 30px; font-size:1rem; width:100%; }
        }
    </style>
</head>
<body>
    <div class="bg-overlay"></div>
    <div class="app">
        <nav>
            <div class="logo" onclick="navigate('home')">𝐁𝐋𝐀𝐂𝐊𝐋𝐎𝐑𝐃 𝐓𝐄𝐂𝐇 𝐈𝐍𝐂</div>
            <button class="menu-toggle" id="menuToggle" aria-label="Toggle navigation">
                <span></span><span></span><span></span>
            </button>
            <div class="nav-links" id="navLinks">
                <a href="#" onclick="navigate('home')">Home</a>
                <a href="#" onclick="navigate('store')">Store</a>
                <a href="#" onclick="navigate('dashboard')" id="navDashboard" class="hide">Dashboard</a>
                <span class="balance-badge hide" id="navBalance">🪙 0 SD</span>
                <a href="#" onclick="navigate('login')" id="navLogin">Log In</a>
                <a href="#" onclick="navigate('signup')" id="navSignup" class="btn-primary">Get Started</a>
                <a href="#" onclick="logout()" id="navLogout" class="hide">Logout</a>
            </div>
        </nav>
        <div id="page-home" class="page active">
            <div class="hero">
                <h1>Power Your Digital World</h1>
                <p class="subtitle">Pterodactyl panel hosting, WhatsApp automation bots, and tech solutions — all under one roof.<br />Powered by <strong>𝐁𝐋𝐀𝐂𝐊𝐋𝐎𝐑𝐃 𝐓𝐄𝐂𝐇 𝐈𝐍𝐂</strong></p>
                <div class="cta"><button onclick="navigate('signup')">Get Started</button></div>
            </div>
        </div>
        <div id="page-login" class="page">
            <div class="form-container">
                <h2>Log In</h2>
                <p class="sub">Welcome back to Blacklord Tech</p>
                <form id="loginForm" onsubmit="login(event)">
                    <label>Email Address</label>
                    <input type="email" id="loginEmail" required />
                    <label>Password</label>
                    <input type="password" id="loginPassword" required />
                    <div id="loginError" class="error-msg"></div>
                    <button type="submit" class="btn-submit">Log In</button>
                </form>
                <div class="form-footer">Don't have an account? <a onclick="navigate('signup')">Sign Up</a></div>
            </div>
        </div>
        <div id="page-signup" class="page">
            <div class="form-container">
                <h2>Create Account</h2>
                <p class="sub">Join Blacklord Tech – it's free</p>
                <form id="signupForm" onsubmit="signup(event)">
                    <label>First Name</label>
                    <input type="text" id="signupFirstName" required />
                    <label>Last Name</label>
                    <input type="text" id="signupLastName" required />
                    <label>Email Address</label>
                    <input type="email" id="signupEmail" required />
                    <label>Password (min. 6 characters)</label>
                    <input type="password" id="signupPassword" minlength="6" required />
                    <label>Confirm Password</label>
                    <input type="password" id="signupConfirm" required />
                    <div id="signupError" class="error-msg"></div>
                    <button type="submit" class="btn-submit">Create Account</button>
                </form>
                <div class="form-footer">Already have an account? <a onclick="navigate('login')">Log In</a></div>
            </div>
        </div>
        <div id="page-dashboard" class="page">
            <div class="welcome-row">
                <div><h1>Welcome back, <span id="userName">User</span> 👋</h1><div class="sub">Manage your panels and VPS from one place.</div></div>
            </div>
            <div class="balance-card">
                <div class="balance-left">
                    <h2>Total Balance</h2>
                    <div class="amount" id="dashBalance">0 <small>SD</small></div>
                    <div class="ksh" id="dashKsh">0.00 KSH</div>
                    <div class="change" id="dashChange">▲ 0.0% from last month</div>
                </div>
                <div class="balance-right">
                    <button onclick="alert('📱 App – coming soon!')">App</button>
                    <button onclick="alert('💰 Sell SD – coming soon!')">Sell SD</button>
                    <button class="btn-gold" onclick="openTopup()">Top Up</button>
                </div>
            </div>
            <div class="stats-grid" id="statsGrid">
                <div class="stat-card"><div class="label">Total Panels</div><div class="value gold" id="statBots">0</div><div class="sub-text" id="statBotsSub">+0 this week</div></div>
                <div class="stat-card"><div class="label">Active Panels</div><div class="value green" id="statActive">0</div><div class="sub-text" id="statActiveSub">0% uptime</div></div>
                <div class="stat-card"><div class="label">Orders</div><div class="value blue" id="statOrders">0</div><div class="sub-text" id="statOrdersSub">+0 pending</div></div>
                <div class="stat-card"><div class="label">Referrals</div><div class="value" id="statReferrals">0</div><div class="sub-text" id="statReferralsSub">+0 this month</div></div>
            </div>
            <div class="offer-banner"><p>🎁 <strong>Refer &amp; Earn</strong> – Earn 5 SD (6.47 KSH) for every deposit your referrals make!</p><a class="btn-link" onclick="alert('🔗 Referral program – coming soon!')">Start earning →</a></div>
            <div class="two-col">
                <div class="quick-access">
                    <h3>⚡ Quick Access</h3>
                    <div class="quick-grid">
                        <div class="quick-btn" onclick="alert('🤖 Deploy Panel – coming soon!')"><span class="icon">🖥️</span>Deploy Panel</div>
                        <div class="quick-btn" onclick="openTopup()"><span class="icon">💳</span>Top Up</div>
                        <div class="quick-btn" onclick="alert('📈 Orders – coming soon!')"><span class="icon">📈</span>Orders</div>
                        <div class="quick-btn" onclick="alert('🔗 Referral – coming soon!')"><span class="icon">🔗</span>Referral</div>
                        <div class="quick-btn" onclick="navigate('store')"><span class="icon">🛒</span>Buy Panel</div>
                        <div class="quick-btn" onclick="alert('📦 My Servers – coming soon!')"><span class="icon">📦</span>My Servers</div>
                        <div class="quick-btn" onclick="alert('🔗 Site Links – coming soon!')"><span class="icon">🔗</span>Site Links</div>
                        <div class="quick-btn" onclick="alert('🧮 Calculator – coming soon!')"><span class="icon">🧮</span>Calculator</div>
                        <div class="quick-btn" onclick="alert('💰 Earn Money – coming soon!')"><span class="icon">💰</span>Earn Money</div>
                        <div class="quick-btn" onclick="alert('⚙️ API – coming soon!')"><span class="icon">⚙️</span>API <span class="badge">NEW</span></div>
                    </div>
                </div>
                <div class="recent-activity">
                    <h3>🔍 Recent Activity</h3>
                    <div id="activityList"><div class="loading-text"><span class="loading"></span> Loading...</div></div>
                </div>
            </div>
        </div>
        <div id="page-store" class="page">
            <h1 style="font-size:2rem; margin-bottom:10px;">🛒 Buy Panels, VPS & Files</h1>
            <p style="color:#aaa; margin-bottom:30px;">All prices in <strong style="color:#ffd700;">SD</strong> (Star Dollars) – 5 SD = 8 KSH</p>
            <div class="topup-section">
                <div><h2>💳 Need more SD?</h2><p>5 SD = 8 KSH. Top up instantly via Paystack.</p></div>
                <div class="topup-buttons">
                    <button onclick="topupPreset(8)">+5 SD (8 KSH)</button>
                    <button onclick="topupPreset(16)">+10 SD (16 KSH)</button>
                    <button onclick="topupPreset(40)">+25 SD (40 KSH)</button>
                    <button onclick="topupPreset(80)">+50 SD (80 KSH)</button>
                    <button class="btn-gold" onclick="openTopup()">Custom Amount</button>
                </div>
            </div>
            <div id="productGrid" class="product-grid"><div class="loading-text"><span class="loading"></span> Loading...</div></div>
            <div id="storeResult"></div>
        </div>
        <div class="footer"><span>© 2026 𝐁𝐋𝐀𝐂𝐊𝐋𝐎𝐑𝐃 𝐓𝐄𝐂𝐇 𝐈𝐍𝐂 – All rights reserved.</span></div>
    </div>
    <div class="modal" id="topupModal">
        <div class="modal-content">
            <h2>💳 Top Up SD</h2>
            <p>Enter amount in <strong>KSH</strong> (5 SD = 8 KSH)</p>
            <input type="number" id="topupAmount" placeholder="Enter KSH amount" min="8" />
            <div id="topupModalError" class="error-msg"></div>
            <div class="btn-group">
                <button class="btn-confirm" id="topupConfirmBtn">Pay Now</button>
                <button class="btn-cancel" id="topupCancelBtn">Cancel</button>
            </div>
        </div>
    </div>

    <script>
        // ─── API BASE URL ──────────────────────────────────────
        window.API_BASE = '';

        const API_BASE = window.API_BASE || '';
        const token = localStorage.getItem('authToken') || null;
        let currentUser = null;
        let products = [];

        function navigate(page) {
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            const target = document.getElementById('page-' + page);
            if (target) target.classList.add('active');
            updateNav();
            if (page === 'dashboard') loadDashboard();
            if (page === 'store') loadProducts();
            if (page !== 'home') window.location.hash = page;
            else history.pushState('', document.title, window.location.pathname);
            document.getElementById('menuToggle').classList.remove('active');
            document.getElementById('navLinks').classList.remove('open');
        }

        function updateNav() {
            const isLoggedIn = !!token;
            document.getElementById('navLogin').style.display = isLoggedIn ? 'none' : 'inline';
            document.getElementById('navSignup').style.display = isLoggedIn ? 'none' : 'inline';
            document.getElementById('navDashboard').style.display = isLoggedIn ? 'inline' : 'none';
            document.getElementById('navLogout').style.display = isLoggedIn ? 'inline' : 'none';
            document.getElementById('navBalance').style.display = isLoggedIn ? 'inline' : 'none';
        }

        document.getElementById('menuToggle').addEventListener('click', function() {
            this.classList.toggle('active');
            document.getElementById('navLinks').classList.toggle('open');
        });
        document.querySelectorAll('.nav-links a, .nav-links .nav-btn').forEach(el => {
            el.addEventListener('click', function() {
                document.getElementById('menuToggle').classList.remove('active');
                document.getElementById('navLinks').classList.remove('open');
            });
        });

        async function signup(e) {
            e.preventDefault();
            const firstName = document.getElementById('signupFirstName').value.trim();
            const lastName = document.getElementById('signupLastName').value.trim();
            const email = document.getElementById('signupEmail').value.trim();
            const password = document.getElementById('signupPassword').value;
            const confirm = document.getElementById('signupConfirm').value;
            const errorEl = document.getElementById('signupError');
            errorEl.textContent = '';
            if (password !== confirm) { errorEl.textContent = '❌ Passwords do not match.'; return; }
            if (password.length < 6) { errorEl.textContent = '❌ Password must be at least 6 characters.'; return; }
            try {
                const res = await fetch(`${API_BASE}/api/signup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ firstName, lastName, email, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Signup failed');
                localStorage.setItem('authToken', data.token);
                location.reload();
            } catch (e) {
                errorEl.textContent = '❌ ' + e.message;
            }
        }

        async function login(e) {
            e.preventDefault();
            const email = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPassword').value;
            const errorEl = document.getElementById('loginError');
            errorEl.textContent = '';
            try {
                const res = await fetch(`${API_BASE}/api/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Login failed');
                localStorage.setItem('authToken', data.token);
                location.reload();
            } catch (e) {
                errorEl.textContent = '❌ ' + e.message;
            }
        }

        function logout() {
            localStorage.removeItem('authToken');
            location.reload();
        }

        async function loadDashboard() {
            if (!token) { navigate('login'); return; }
            try {
                const res = await fetch(`${API_BASE}/api/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Unauthorized');
                currentUser = data.user;
                document.getElementById('userName').textContent = currentUser.firstName || 'User';
                const sd = currentUser.sdBalance || 0;
                const ksh = sd * 1.6;
                document.getElementById('dashBalance').innerHTML = `${sd} <small>SD</small>`;
                document.getElementById('dashKsh').textContent = `${ksh.toFixed(2)} KSH`;
                document.getElementById('navBalance').textContent = `🪙 ${sd} SD`;
                document.getElementById('statBots').textContent = currentUser.totalPanels || 0;
                document.getElementById('statActive').textContent = currentUser.activePanels || 0;
                document.getElementById('statOrders').textContent = currentUser.orders || 0;
                document.getElementById('statReferrals').textContent = currentUser.referralsCount || 0;
                loadActivity();
            } catch (e) {
                logout();
            }
        }

        async function loadActivity() {
            const container = document.getElementById('activityList');
            try {
                const res = await fetch(`${API_BASE}/api/activity`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                const activities = data.activities || [
                    { type: 'panel', desc: 'Panel Deployed: myvps', amount: -1250, date: '17 Jun 2026' },
                    { type: 'topup', desc: 'SD Top-up', amount: 50, date: '16 Jun 2026' },
                    { type: 'referral', desc: 'Referral Bonus', amount: 5, date: '15 Jun 2026' },
                ];
                const dotMap = { panel: 'gold', topup: 'green', referral: 'gold' };
                container.innerHTML = activities.map(a => `
                    <div class="activity-item">
                        <div class="left">
                            <div class="dot ${dotMap[a.type] || 'gold'}"></div>
                            <div class="desc">${a.desc}<small>${a.date || 'Just now'}</small></div>
                        </div>
                        <div class="amount ${a.amount >= 0 ? 'positive' : 'negative'}">${a.amount >= 0 ? '+' : ''}${a.amount} SD</div>
                    </div>
                `).join('');
            } catch (e) {
                container.innerHTML = '<div style="color:#888;">Could not load activity.</div>';
            }
        }

        async function loadProducts() {
            const grid = document.getElementById('productGrid');
            try {
                const res = await fetch(`${API_BASE}/api/products`);
                if (!res.ok) throw new Error('Failed to load');
                const data = await res.json();
                products = [...data.panels, ...data.vps, ...data.files];
                if (!products.length) { grid.innerHTML = '<p style="color:#888;">No products available.</p>'; return; }
                grid.innerHTML = products.map(p => {
                    const sdPrice = Math.round(p.price / 1.6);
                    return `<div class="product-card">
                        <h3>${p.name}</h3>
                        <div class="price-sd">${sdPrice} <small>SD</small></div>
                        <div class="price-ksh">≈ ${p.price} KSH</div>
                        <div style="color:#888; font-size:0.9rem; margin:8px 0;">${p.description || p.ram || ''}</div>
                        <button onclick="buyProduct('${p.type}', '${p.id}', ${sdPrice})">Buy Now (${sdPrice} SD)</button>
                    </div>`;
                }).join('');
            } catch (e) {
                grid.innerHTML = '<p class="error" style="color:#ff6b6b;">❌ Could not load products.</p>';
            }
        }

        async function buyProduct(type, id, sdPrice) {
            if (!token) { navigate('login'); return; }
            if (!currentUser) await loadDashboard();
            if ((currentUser?.sdBalance || 0) < sdPrice) {
                alert(`❌ Insufficient SD balance! You have ${currentUser?.sdBalance || 0} SD. Need ${sdPrice} SD.\n\nTop up first!`);
                return;
            }
            const username = prompt('Enter a username for your new server (letters, numbers, underscores):');
            if (!username) return;
            if (!/^[a-zA-Z0-9_-]{3,}$/.test(username)) {
                alert('Username must be at least 3 characters (letters, numbers, underscore).');
                return;
            }
            const resultEl = document.getElementById('storeResult');
            resultEl.innerHTML = '<div style="color:#aaa;">⏳ Processing your purchase...</div>';
            try {
                const res = await fetch(`${API_BASE}/api/buy`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ productType: type, productId: id, username })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (res.status === 402) throw new Error(`Insufficient SD. You have ${data.sdBalance||0} SD, need ${data.sdRequired||sdPrice}.`);
                    throw new Error(data.error || 'Purchase failed');
                }
                let html = '<div class="success-msg">✅ Purchase successful!</div>';
                if (data.panel) {
                    html += `<div><strong>Panel Credentials:</strong><br>Username: ${data.panel.username}<br>Password: ${data.panel.password}<br>Domain: ${data.panel.domain}</div>`;
                } else if (data.vps) {
                    html += `<div><strong>VPS Credentials:</strong><br>IP: ${data.vps.ip}<br>Password: ${data.vps.password}<br>ID: ${data.vps.dropletId}</div>`;
                } else if (data.file) {
                    html += `<div>✅ File <strong>${data.file.name}</strong> is ready.</div>`;
                }
                resultEl.innerHTML = html;
                await loadDashboard();
            } catch (e) {
                resultEl.innerHTML = `<div class="error-msg">❌ ${e.message}</div>`;
            }
        }

        function topupPreset(ksh) {
            document.getElementById('topupAmount').value = ksh;
            openTopup();
        }

        function openTopup() {
            document.getElementById('topupModal').classList.add('active');
            document.getElementById('topupModalError').textContent = '';
        }

        document.getElementById('topupConfirmBtn').addEventListener('click', async () => {
            const amount = parseInt(document.getElementById('topupAmount').value);
            const errorEl = document.getElementById('topupModalError');
            errorEl.textContent = '';
            if (!amount || amount < 8) { errorEl.textContent = '❌ Minimum top-up is 8 KSH (5 SD).'; return; }
            try {
                const res = await fetch(`${API_BASE}/api/topup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ amountKsh: amount })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Top-up failed');
                if (data.authorization_url) window.location.href = data.authorization_url;
                else throw new Error('No payment URL');
            } catch (e) {
                errorEl.textContent = '❌ ' + e.message;
            }
        });

        document.getElementById('topupCancelBtn').addEventListener('click', () => {
            document.getElementById('topupModal').classList.remove('active');
        });

        (function init() {
            const params = new URLSearchParams(window.location.search);
            const ref = params.get('reference');
            if (ref) {
                const resultEl = document.getElementById('storeResult') || document.createElement('div');
                resultEl.innerHTML = '<div style="color:#aaa;">⏳ Verifying payment...</div>';
                fetch(`${API_BASE}/api/verify-payment?reference=${ref}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.error) throw new Error(data.error);
                        resultEl.innerHTML = `<div class="success-msg">✅ ${data.message || 'Payment successful!'}</div>`;
                        if (data.sdBalance !== undefined) {
                            document.getElementById('navBalance').textContent = `🪙 ${data.sdBalance} SD`;
                            if (currentUser) currentUser.sdBalance = data.sdBalance;
                        }
                        window.history.replaceState({}, document.title, window.location.pathname);
                    })
                    .catch(err => {
                        resultEl.innerHTML = `<div class="error-msg">❌ ${err.message}</div>`;
                    });
            }

            const hash = window.location.hash.replace('#', '');
            if (hash && ['home', 'login', 'signup', 'dashboard', 'store'].includes(hash)) {
                navigate(hash);
            } else {
                navigate('home');
            }

            if (token) {
                fetch(`${API_BASE}/api/me`, { headers: { 'Authorization': `Bearer ${token}` } })
                    .then(res => res.json())
                    .then(data => {
                        if (data.user) {
                            currentUser = data.user;
                            updateNav();
                            document.getElementById('navBalance').textContent = `🪙 ${currentUser.sdBalance || 0} SD`;
                            if (document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
                            if (document.getElementById('page-store').classList.contains('active')) loadProducts();
                        } else {
                            logout();
                        }
                    })
                    .catch(() => logout());
            } else {
                updateNav();
            }
        })();
    </script>
</body>
</html>`;

// ─── SERVE HTML ──────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(HTML);
});

app.get('*', (req, res) => {
    res.send(HTML);
});

// ─── START SERVER ────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📍 Open http://localhost:${PORT} in your browser`);
    console.log(``);
    console.log(`🔑 Paystack Test Keys:`);
    console.log(`   Secret: sk_test_061c255581146664ed28fa5e1ac3c808e3103c4f`);
    console.log(`   Public: pk_test_6bdd15abf5fe31d1b38ea32699a533a383efc9dc`);
    console.log(``);
    console.log(`⚠️  IMPORTANT: Replace PANEL_DOMAIN and PANEL_APIKEY with your real values!`);
});