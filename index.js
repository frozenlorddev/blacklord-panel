// ============================================================
//   BLACKLORD TECH – MINIMAL BACKEND (for testing)
// ============================================================
'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────
const JWT_SECRET = 'your-super-secret-key';
const PORT = 3002;

// ─── Database (in-memory for testing) ──────────────────────
let users = {};
let userIdCounter = 1;

// ─── Helpers ──────────────────────────────────────────────────
function generateReferralCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── API ROUTES ──────────────────────────────────────────────

// Test endpoint – if this works, JSON is alive
app.get('/api/test', (req, res) => {
    res.json({ status: 'OK', message: 'JSON works!' });
});

// Create account (username only)
app.post('/api/create-account', (req, res) => {
    console.log('✅ /api/create-account called with:', req.body);
    const { username } = req.body;

    if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Only letters, numbers, and underscore allowed' });
    }

    // Check if username already exists
    const existing = Object.values(users).find(u => u.firstName.toLowerCase() === username.toLowerCase());
    if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
    }

    // Create user
    const userId = `user_${Date.now()}`;
    const dummyEmail = `${username}@blacklord.local`;
    const newUser = {
        email: dummyEmail,
        firstName: username,
        lastName: '',
        sdBalance: 0,
        panels: [],
        bots: [],
        referralCode: generateReferralCode(),
        registeredAt: new Date().toISOString(),
    };
    users[userId] = newUser;

    // Generate token
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });

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

// ─── STATIC FILES ──────────────────────────────────────────────
app.use(express.static(__dirname));

// Catch-all: serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START SERVER ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🔹 Test JSON at http://localhost:${PORT}/api/test`);
    console.log(`🔹 Create account at POST http://localhost:${PORT}/api/create-account`);
});