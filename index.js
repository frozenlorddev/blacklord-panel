// ============================================================
//   BLACKLORD TECH – FULL BACKEND with MongoDB
// ============================================================
'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mongoose = require('mongoose');
const session = require('express-session');

const app = express();

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── MongoDB Connection ──────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not defined in environment variables.');
    process.exit(1);
}

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
});

// ─── Mongoose Models ──────────────────────────────────────────
const UserSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    firstName: String,
    lastName: String,
    passwordHash: String,
    googleId: String,
    sdBalance: { type: Number, default: 0 },
    panels: [{
        username: String,
        password: String,
        domain: String,
        plan: String,
        sdPrice: Number,
        status: { type: String, enum: ['active', 'inactive', 'expired'], default: 'active' },
        type: { type: String, enum: ['panel', 'admin', 'trial'], default: 'panel' },
        trial: { type: Boolean, default: false },
        expiresAt: Date,
        serverId: String,
        reused: Boolean,
        createdAt: { type: Date, default: Date.now }
    }],
    bots: [{
        name: String,
        type: String,
        token: String,
        status: { type: String, enum: ['active', 'inactive'], default: 'active' },
        createdAt: { type: Date, default: Date.now }
    }],
    referralsCount: { type: Number, default: 0 },
    referralCode: String,
    registeredAt: { type: Date, default: Date.now },
    voucherRedemptions: [{
        code: String,
        amount: Number,
        redeemedAt: { type: Date, default: Date.now }
    }],
    transactions: [{
        type: String,
        amountKsh: Number,
        sdReceived: Number,
        reference: String,
        status: String,
        createdAt: { type: Date, default: Date.now }
    }]
});
const User = mongoose.model('User', UserSchema);

const VoucherSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    sdAmount: Number,
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    usedAt: Date,
    createdAt: { type: Date, default: Date.now }
});
const Voucher = mongoose.model('Voucher', VoucherSchema);

const LogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: String,
    details: Object,
    timestamp: { type: Date, default: Date.now }
});
const Log = mongoose.model('Log', LogSchema);

const PendingPaymentSchema = new mongoose.Schema({
    reference: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    phone: String,
    amountKsh: Number,
    sdAmount: Number,
    checkoutRequestID: String,
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    createdAt: { type: Date, default: Date.now },
    completedAt: Date,
    error: String
});
const PendingPayment = mongoose.model('PendingPayment', PendingPaymentSchema);

// ─── Config ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const PORT = process.env.PORT || 3002;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@blacklordtech.com';

// Pterodactyl
const PANEL_DOMAIN = process.env.PANEL_DOMAIN;
const PANEL_APIKEY = process.env.PANEL_APIKEY;
const PANEL_EGG   = parseInt(process.env.PANEL_EGG) || 15;
const PANEL_NEST  = parseInt(process.env.PANEL_NEST) || 5;
const PANEL_LOC   = parseInt(process.env.PANEL_LOC) || 1;

// M-PESA
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || `http://localhost:${PORT}/api/mpesa/callback`;
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';

// ─── Session (optional) ──────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret';
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Helpers ──────────────────────────────────────────────────
function generateReferralCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function generatePassword(username) {
    const first = username.charAt(0).toUpperCase();
    const rest = username.slice(1).toLowerCase();
    const digits = String(Math.floor(Math.random() * 90 + 10));
    return first + rest + digits + '!';
}
function getRam(plan) {
    const map = { '5gb': 5120, 'unlimited': 0 };
    return map[plan] || 5120;
}
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}
async function addLog(userId, action, details = {}) {
    const log = new Log({ userId, action, details });
    await log.save();
}

// ─── Pterodactyl Helpers ────────────────────────────────────
async function findPterodactylUser(username) {
    try {
        const response = await axios.get(
            `${PANEL_DOMAIN}/api/application/users?filter[email]=${username}@gmail.com`,
            { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 10000 }
        );
        const users = response.data.data;
        if (users && users.length > 0) return users[0].attributes.id;
        return null;
    } catch (e) {
        return null;
    }
}

async function createPterodactylPanel(username, ramMB, diskMB, cpuPercent, isAdmin = false) {
    let existingUserId = await findPterodactylUser(username);
    let userId, userPassword = null;

    if (!existingUserId) {
        userPassword = generatePassword(username);
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
            { headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        userId = userRes.data.attributes.id;
    } else {
        userId = existingUserId;
    }

    const allocRes = await axios.get(
        `${PANEL_DOMAIN}/api/application/nodes/${PANEL_LOC}/allocations`,
        { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 15000 }
    );
    const alloc = allocRes.data.data.find(a => a.attributes.assigned === false);
    if (!alloc) throw new Error('No available port');

    const eggRes = await axios.get(
        `${PANEL_DOMAIN}/api/application/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`,
        { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 15000 }
    );
    const egg = eggRes.data.attributes;
    const env = {};
    if (egg.relationships?.variables?.data) {
        for (const v of egg.relationships.variables.data) {
            const key = v.attributes.env_variable;
            if (key) env[key] = v.attributes.default_value || '';
        }
    }
    env.NODE_VERSION = '18';
    env.INST = 'npm';
    env.CMD_RUN = 'npm start';

    const serverData = {
        name: `${username}-${isAdmin ? 'admin' : 'panel'}-${Date.now().toString().slice(-4)}`,
        user: userId,
        egg: PANEL_EGG,
        docker_image: egg.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
        startup: egg.startup || 'npm start',
        environment: env,
        skip_scripts: false,
        limits: { memory: ramMB, swap: 0, disk: diskMB, io: 500, cpu: cpuPercent },
        feature_limits: { databases: 1, backups: 1 },
        allocation: { default: alloc.attributes.id },
        deployment: { locations: [PANEL_LOC] },
        start_on_completion: true,
    };

    const srvRes = await axios.post(
        `${PANEL_DOMAIN}/api/application/servers`,
        serverData,
        { headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    return {
        username: username,
        password: existingUserId ? null : userPassword,
        domain: PANEL_DOMAIN,
        serverId: srvRes.data.attributes.id,
        reused: !!existingUserId,
    };
}

// ─── M-PESA Helpers ──────────────────────────────────────────
async function getMpesaAccessToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    const url = MPESA_ENV === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('M-PESA access token error:', error.response?.data || error.message);
        throw new Error('Failed to get M-PESA access token');
    }
}

async function stkPush(phone, amount, accountReference, transactionDesc) {
    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const url = MPESA_ENV === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const data = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: accountReference || 'BLACKLORD',
        TransactionDesc: transactionDesc || 'SD Top-up',
    };

    try {
        const response = await axios.post(url, data, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('STK Push error:', error.response?.data || error.message);
        throw new Error('STK Push request failed');
    }
}

// ─── API ROUTES ──────────────────────────────────────────────

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ status: 'OK', message: 'API is working' });
});

// ─── CREATE ACCOUNT ──────────────────────────────────────────
app.post('/api/create-account', async (req, res) => {
    console.log('🔹 /api/create-account called with:', req.body);
    const { username } = req.body;
    if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Only letters, numbers, and underscore allowed' });
    }

    // Check if username already exists (case-insensitive)
    const existing = await User.findOne({ firstName: { $regex: new RegExp('^' + username + '$', 'i') } });
    if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
    }

    const dummyEmail = `${username}@blacklord.local`;
    const newUser = new User({
        email: dummyEmail,
        firstName: username,
        lastName: '',
        sdBalance: 0,
        referralCode: generateReferralCode(),
        registeredAt: new Date(),
    });
    await newUser.save();

    const token = jwt.sign({ userId: newUser._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
        token,
        user: {
            email: dummyEmail,
            firstName: username,
            lastName: '',
            sdBalance: 0,
            totalServers: 0,
            activeServers: 0,
        }
    });
});

// ─── Health ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ─── GET CURRENT USER ──────────────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Auto-expire trial panels
    let changed = false;
    const now = new Date();
    user.panels.forEach(p => {
        if (p.trial && p.status === 'active' && p.expiresAt && p.expiresAt <= now) {
            p.status = 'expired';
            changed = true;
        }
    });
    if (changed) await user.save();

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
            voucherRedemptions: user.voucherRedemptions || [],
        }
    });
});

// ─── BUY PANEL ────────────────────────────────────────────────
const PLAN_MAP = {
    '5gb':       { plan: '5gb', ram: 5120, qty: 1 },
    'unlimited': { plan: 'unlimited', ram: 0, qty: 1 },
    'bundle-2':  { plan: 'unlimited', ram: 0, qty: 2 },
    'bundle-3':  { plan: 'unlimited', ram: 0, qty: 3 },
    'bundle-4':  { plan: 'unlimited', ram: 0, qty: 4 },
};

app.post('/api/buy', authMiddleware, async (req, res) => {
    const { productType, productId, username, password, quantity = 1 } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (productType !== 'panel') {
        return res.status(400).json({ error: 'Invalid product type' });
    }

    const info = PLAN_MAP[productId];
    if (!info) return res.status(400).json({ error: 'Invalid product' });

    const { plan, ram, qty } = info;
    const finalQuantity = qty;

    // Price map (KSH)
    const prices = {
        '5gb': 50,
        'unlimited': 70,
        'bundle-2': 100,
        'bundle-3': 130,
        'bundle-4': 150
    };
    const kshPrice = prices[productId];
    if (!kshPrice) return res.status(400).json({ error: 'Price not configured' });
    const totalSdPrice = Math.round(kshPrice / 1.6);
    if (totalSdPrice <= 0) return res.status(400).json({ error: 'Price invalid' });

    if ((user.sdBalance || 0) < totalSdPrice) {
        return res.status(402).json({
            error: 'Insufficient SD balance',
            sdBalance: user.sdBalance || 0,
            sdRequired: totalSdPrice,
        });
    }

    user.sdBalance -= totalSdPrice;
    await user.save();

    const createdPanels = [];
    const failed = [];
    const unitPrice = Math.round(totalSdPrice / finalQuantity);

    for (let i = 1; i <= finalQuantity; i++) {
        let finalUsername = username;
        if (finalQuantity > 1) finalUsername = `${username}${i}`;
        try {
            const diskMB = ram === 0 ? 0 : ram * 2;
            const panelResult = await createPterodactylPanel(finalUsername, ram, diskMB, 40, false);
            const panelRecord = {
                username: finalUsername,
                password: panelResult.password || generatePassword(finalUsername),
                domain: panelResult.domain,
                plan: plan,
                sdPrice: unitPrice,
                status: 'active',
                type: 'panel',
                serverId: panelResult.serverId,
                reused: panelResult.reused,
                createdAt: new Date(),
                trial: false,
            };
            user.panels.push(panelRecord);
            createdPanels.push(panelRecord);
            await user.save();
        } catch (error) {
            failed.push({ username: finalUsername, error: error.message });
        }
    }

    if (failed.length > 0) {
        const refundSd = unitPrice * failed.length;
        user.sdBalance += refundSd;
        await user.save();
    }

    await addLog(req.userId, 'purchase_panels', { productId, quantity: finalQuantity, created: createdPanels.length, failed: failed.length });
    res.json({
        success: true,
        created: createdPanels.length,
        failed: failed.length,
        panels: createdPanels.map(p => ({ username: p.username, password: p.password, domain: p.domain, plan: p.plan })),
        errors: failed,
    });
});

// ─── CLAIM FREE TRIAL ──────────────────────────────────────────
app.post('/api/claim-free-panel', authMiddleware, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const existing = user.panels.find(p => p.trial && p.status === 'active');
    if (existing) {
        if (existing.expiresAt && new Date(existing.expiresAt) > new Date()) {
            return res.status(400).json({
                error: 'You already have an active trial',
                panel: { username: existing.username, domain: existing.domain, expiresAt: existing.expiresAt }
            });
        } else {
            return res.status(400).json({ error: 'Your trial has expired. Purchase a full panel.' });
        }
    }

    const username = `trial_${user.firstName.toLowerCase()}_${Date.now().toString().slice(-4)}`;
    const password = generatePassword(username);
    const ramMB = 5120, diskMB = 10240, cpuPercent = 40;
    try {
        const panelResult = await createPterodactylPanel(username, ramMB, diskMB, cpuPercent, false);
        const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
        const panelRecord = {
            username,
            password: panelResult.password || password,
            domain: panelResult.domain,
            plan: '5gb',
            sdPrice: 0,
            status: 'active',
            type: 'trial',
            trial: true,
            expiresAt,
            serverId: panelResult.serverId,
            reused: panelResult.reused,
            createdAt: new Date(),
        };
        user.panels.push(panelRecord);
        await user.save();
        await addLog(req.userId, 'claim_free_trial', { username, expiresAt });
        res.json({ success: true, panel: { username, password: panelResult.password || password, domain: panelResult.domain, expiresAt } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create trial: ' + error.message });
    }
});

// ─── PANEL MANAGEMENT ──────────────────────────────────────────
app.post('/api/toggle-panel', authMiddleware, async (req, res) => {
    const { username } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const panel = user.panels.find(p => p.username === username);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    panel.status = panel.status === 'active' ? 'inactive' : 'active';
    await user.save();
    await addLog(req.userId, 'toggle_panel', { username, newStatus: panel.status });
    res.json({ success: true, status: panel.status });
});

app.post('/api/delete-panel', authMiddleware, async (req, res) => {
    const { username } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const idx = user.panels.findIndex(p => p.username === username);
    if (idx === -1) return res.status(404).json({ error: 'Panel not found' });
    user.panels.splice(idx, 1);
    await user.save();
    await addLog(req.userId, 'delete_panel', { username });
    res.json({ success: true });
});

// ─── BOT MANAGEMENT ────────────────────────────────────────────
app.post('/api/deploy-bot', authMiddleware, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Bot name required' });
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const bot = {
        name,
        type: 'Samsung XMD',
        token: Math.random().toString(36).substring(2, 10) + ':' + Math.random().toString(36).substring(2, 14),
        status: 'active',
        createdAt: new Date(),
    };
    user.bots.push(bot);
    await user.save();
    await addLog(req.userId, 'deploy_bot', { name });
    res.json({ success: true, bot });
});

app.post('/api/toggle-bot', authMiddleware, async (req, res) => {
    const { token } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const bot = user.bots.find(b => b.token === token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.status = bot.status === 'active' ? 'inactive' : 'active';
    await user.save();
    res.json({ success: true, status: bot.status });
});

app.post('/api/delete-bot', authMiddleware, async (req, res) => {
    const { token } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const idx = user.bots.findIndex(b => b.token === token);
    if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
    user.bots.splice(idx, 1);
    await user.save();
    res.json({ success: true });
});

// ─── VOUCHER SYSTEM ────────────────────────────────────────────
app.post('/api/redeem-voucher', authMiddleware, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Voucher code required' });
    const voucher = await Voucher.findOne({ code: code.toUpperCase(), usedBy: null });
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    user.sdBalance = (user.sdBalance || 0) + voucher.sdAmount;
    voucher.usedBy = user._id;
    voucher.usedAt = new Date();
    await user.save();
    await voucher.save();
    if (!user.voucherRedemptions) user.voucherRedemptions = [];
    user.voucherRedemptions.push({ code: voucher.code, amount: voucher.sdAmount, redeemedAt: new Date() });
    await user.save();
    await addLog(req.userId, 'redeem_voucher', { code, sdAmount: voucher.sdAmount });
    res.json({ success: true, message: `Redeemed ${voucher.sdAmount} SD`, sdAmount: voucher.sdAmount });
});

app.post('/api/admin/generate-voucher', authMiddleware, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
    const { sdAmount } = req.body;
    if (!sdAmount || sdAmount < 1) return res.status(400).json({ error: 'Invalid SD amount' });
    const code = 'VOUCHER-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const voucher = new Voucher({ code, sdAmount: parseInt(sdAmount) });
    await voucher.save();
    await addLog(req.userId, 'generate_voucher', { code, sdAmount });
    res.json({ success: true, code, sdAmount });
});

app.get('/api/admin/vouchers', authMiddleware, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
    const vouchers = await Voucher.find().sort({ createdAt: -1 });
    res.json({ vouchers });
});

// ─── ADMIN ENDPOINTS ──────────────────────────────────────────
app.get('/api/admin/users', authMiddleware, async (req, res) => {
    const admin = await User.findById(req.userId);
    if (!admin || admin.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
    const users = await User.find().select('-passwordHash -googleId');
    res.json({ users });
});

app.post('/api/admin/adjust-balance', authMiddleware, async (req, res) => {
    const admin = await User.findById(req.userId);
    if (!admin || admin.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.sdBalance = (user.sdBalance || 0) + amount;
    await user.save();
    await addLog(userId, 'admin_adjust_balance', { by: req.userId, amount });
    res.json({ success: true, newBalance: user.sdBalance });
});

app.get('/api/admin/logs', authMiddleware, async (req, res) => {
    const admin = await User.findById(req.userId);
    if (!admin || admin.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
    const logs = await Log.find().sort({ timestamp: -1 }).limit(200);
    res.json({ logs });
});

// ─── M-PESA TOP-UP ─────────────────────────────────────────────
app.post('/api/topup', authMiddleware, async (req, res) => {
    const { amountKsh, phone } = req.body;
    if (!amountKsh || amountKsh < 8) {
        return res.status(400).json({ error: 'Minimum top-up is 8 KSH' });
    }
    if (!phone || !/^254[0-9]{9}$/.test(phone)) {
        return res.status(400).json({ error: 'Invalid phone number. Use format 2547XXXXXXXX' });
    }

    const sdAmount = Math.round(amountKsh / 1.6);
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const reference = `TOP${Date.now().toString().slice(-8)}${req.userId.slice(-4)}`;

    try {
        const stkResponse = await stkPush(phone, amountKsh, reference, 'SD Top-up');

        if (stkResponse.ResponseCode === '0') {
            const pending = new PendingPayment({
                reference,
                userId: user._id,
                phone,
                amountKsh,
                sdAmount,
                checkoutRequestID: stkResponse.CheckoutRequestID,
                status: 'pending',
            });
            await pending.save();
            await addLog(req.userId, 'topup_initiated', { amountKsh, sdAmount, phone, reference });

            res.json({
                success: true,
                message: 'STK Push sent. Check your phone and enter PIN.',
                checkoutRequestID: stkResponse.CheckoutRequestID,
                reference
            });
        } else {
            res.status(500).json({
                error: 'Failed to initiate payment: ' + stkResponse.ResponseDescription,
                details: stkResponse
            });
        }
    } catch (error) {
        console.error('Topup error:', error.message);
        res.status(500).json({ error: 'Failed to initiate payment: ' + error.message });
    }
});

// ─── M-PESA CALLBACK ──────────────────────────────────────────
app.post('/api/mpesa/callback', async (req, res) => {
    const callbackData = req.body;
    console.log('M-PESA Callback received:', JSON.stringify(callbackData, null, 2));

    const stkCallback = callbackData?.Body?.stkCallback;
    if (!stkCallback) {
        return res.status(400).send('Invalid callback');
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = stkCallback;

    const pending = await PendingPayment.findOne({ checkoutRequestID: CheckoutRequestID });
    if (!pending) {
        console.warn('No pending payment found for CheckoutRequestID:', CheckoutRequestID);
        return res.status(404).send('Payment not found');
    }

    if (ResultCode === 0) {
        let amount = null;
        if (CallbackMetadata && CallbackMetadata.Item) {
            const item = CallbackMetadata.Item.find(i => i.Name === 'Amount');
            if (item) amount = item.Value;
        }
        if (!amount) amount = pending.amountKsh;

        const user = await User.findById(pending.userId);
        if (user) {
            user.sdBalance = (user.sdBalance || 0) + pending.sdAmount;
            if (!user.transactions) user.transactions = [];
            user.transactions.push({
                type: 'topup',
                amountKsh: amount,
                sdReceived: pending.sdAmount,
                reference: pending.reference,
                status: 'success',
                createdAt: new Date()
            });
            await user.save();
            await addLog(pending.userId, 'topup_success', { amountKsh: amount, sdAmount: pending.sdAmount, reference: pending.reference });
        }

        pending.status = 'completed';
        pending.completedAt = new Date();
        await pending.save();

        res.json({ ResultCode: 0, ResultDesc: 'Success' });
    } else {
        pending.status = 'failed';
        pending.error = ResultDesc;
        await pending.save();
        await addLog(pending.userId, 'topup_failed', { reference: pending.reference, reason: ResultDesc });
        res.json({ ResultCode: 0, ResultDesc: 'Payment failed' });
    }
});

// ─── FALLBACK: For any /api/* route not found ────────────────
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// ─── STATIC FILES & CATCH-ALL ──────────────────────────────────
app.use(express.static(__dirname));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START SERVER ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📍 Open http://localhost:${PORT} in your browser`);
    console.log(`🔹 Test API: http://localhost:${PORT}/api/test`);
    if (!PANEL_DOMAIN || !PANEL_APIKEY) {
        console.warn('⚠️  PANEL_DOMAIN or PANEL_APIKEY not set. Panel creation will fail.');
    }
    console.log('✅ Username‑only sign‑up enabled (no password, no Google).');
});