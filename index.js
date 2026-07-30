const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Database ────────────────────────────────────────────────
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'mzazi-tech-secret-2024';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'mzazi-admin-secret-2024';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@mzazi.shop';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '42246776@aA';

// Ensure tables exist on startup
(async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        firstname VARCHAR(255) NOT NULL DEFAULT '',
        lastname VARCHAR(255) NOT NULL DEFAULT '',
        fullname VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wallet (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) UNIQUE NOT NULL,
        balance DECIMAL(10,2) DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        reference VARCHAR(255),
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS panels (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        ptero_server_id INTEGER,
        ptero_user_id INTEGER,
        ptero_username VARCHAR(255),
        ptero_password VARCHAR(255),
        ptero_email VARCHAR(255),
        package_name VARCHAR(255),
        package_price DECIMAL(10,2),
        nest_id INTEGER,
        egg_id INTEGER,
        status VARCHAR(50) DEFAULT 'active',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS packages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        cpu INTEGER NOT NULL DEFAULT 0,
        ram INTEGER NOT NULL DEFAULT 0,
        disk INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        popular BOOLEAN DEFAULT false,
        accent VARCHAR(20) DEFAULT '#2563eb',
        active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        expires_after_hours INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    // Seed default packages if empty
    const cnt = await sql`SELECT COUNT(*) AS c FROM packages`;
    if (parseInt(cnt[0].c) === 0) {
      await sql`
        INSERT INTO packages (name, price, cpu, ram, disk, description, popular, accent, sort_order)
        VALUES
          ('Starter',  50,  20,  512,   2048,  'Perfect for small bots',           false, '#1e3a8a', 1),
          ('Standard', 75,  50,  1024,  5120,  'Great for games & bots',            true,  '#2563eb', 2),
          ('Premium',  100, 100, 5120,  10240, 'High-performance servers',          false, '#1d4ed8', 3),
          ('Ultimate', 120, 0,   0,     0,     'No limits. Maximum performance.',   false, '#4f46e5', 4)
      `;
    }
    await sql`
      CREATE TABLE IF NOT EXISTS inquiries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_email VARCHAR(255),
        user_name VARCHAR(255),
        subject VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'open',
        admin_reply TEXT,
        replied_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS inquiry_messages (
        id SERIAL PRIMARY KEY,
        inquiry_id INTEGER REFERENCES inquiries(id) ON DELETE CASCADE,
        sender VARCHAR(20) NOT NULL DEFAULT 'user',
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS testimonials (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        message TEXT NOT NULL,
        approved BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS voucher_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_by VARCHAR(255),
        used_by INTEGER REFERENCES users(id),
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('✅ Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
})();

// ─── Helper functions ─────────────────────────────────────────
function getToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function verifyUser(req) {
  const token = getToken(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const users = await sql`SELECT * FROM users WHERE id = ${decoded.userId}`;
    return users[0] || null;
  } catch { return null; }
}

async function verifyAdmin(req) {
  const token = getToken(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (decoded.role === 'admin') return decoded;
    return null;
  } catch { return null; }
}

// ─── API Routes ──────────────────────────────────────────────

// ─── Auth ─────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { firstname, lastname, email, password } = req.body;
    if (!firstname || !lastname || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    const exist = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (exist.length) return res.status(400).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 12);
    const fullname = `${firstname} ${lastname}`;
    const [user] = await sql`
      INSERT INTO users (firstname, lastname, fullname, email, password)
      VALUES (${firstname}, ${lastname}, ${fullname}, ${email}, ${hashed})
      RETURNING id
    `;
    await sql`INSERT INTO wallet (user_id, balance) VALUES (${user.id}, 0) ON CONFLICT DO NOTHING`;
    res.json({ message: 'Account created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [user] = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.password) return res.status(401).json({ error: 'Use Google login' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, firstname: user.firstname, lastname: user.lastname, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => res.json({ message: 'Logged out' }));

app.get('/api/auth/me', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user });
});

// ─── Wallet ────────────────────────────────────────────────────
app.get('/api/wallet/balance', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const [wallet] = await sql`SELECT balance FROM wallet WHERE user_id = ${user.id}`;
  const balance = wallet ? parseFloat(wallet.balance) : 0;
  const txns = await sql`
    SELECT * FROM wallet_transactions WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 10
  `;
  res.json({ balance, transactions: txns });
});

// ─── Packages ─────────────────────────────────────────────────
app.get('/api/packages', async (req, res) => {
  const pkgs = await sql`
    SELECT * FROM packages WHERE active = true ORDER BY sort_order ASC
  `;
  res.json({ packages: pkgs });
});

// ─── Panels ───────────────────────────────────────────────────
app.post('/api/panel/create', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { package_id, ptero_username, ptero_password, firstname, lastname, nest_id, egg_id } = req.body;
  if (!package_id || !ptero_username || !ptero_password || !firstname || !lastname || !nest_id || !egg_id) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const [pkg] = await sql`SELECT * FROM packages WHERE id = ${parseInt(package_id)} AND active = true`;
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  const [wallet] = await sql`SELECT balance FROM wallet WHERE user_id = ${user.id}`;
  const balance = wallet ? parseFloat(wallet.balance) : 0;
  if (balance < parseFloat(pkg.price)) {
    return res.status(402).json({ error: `Insufficient balance. Need KSH ${pkg.price}` });
  }

  // Simulate Pterodactyl creation (mock)
  const pteroServerId = Math.floor(Math.random() * 1000000);
  const pteroUserId = Math.floor(Math.random() * 100000);

  await sql`
    UPDATE wallet SET balance = balance - ${parseFloat(pkg.price)} WHERE user_id = ${user.id}
  `;
  await sql`
    INSERT INTO wallet_transactions (user_id, type, amount, description, status)
    VALUES (${user.id}, 'deduction', ${parseFloat(pkg.price)}, ${'Panel: ' + pkg.name}, 'success')
  `;
  const expiresAt = pkg.expires_after_hours
    ? new Date(Date.now() + parseInt(pkg.expires_after_hours) * 3600000)
    : null;

  await sql`
    INSERT INTO panels
      (user_id, ptero_server_id, ptero_user_id, ptero_username, ptero_password, ptero_email,
       package_name, package_price, nest_id, egg_id, expires_at)
    VALUES (
      ${user.id}, ${pteroServerId}, ${pteroUserId},
      ${ptero_username}, ${ptero_password}, ${ptero_username + '@panel.local'},
      ${pkg.name}, ${parseFloat(pkg.price)}, ${parseInt(nest_id)}, ${parseInt(egg_id)},
      ${expiresAt}
    )
  `;
  res.json({
    message: 'Panel created',
    panel: {
      ptero_server_id: pteroServerId,
      username: ptero_username,
      password: ptero_password,
      panel_url: 'https://public.mzazi.shop',
      package: pkg.name,
      expires_at: expiresAt,
    },
  });
});

app.get('/api/panel/list', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const panels = await sql`SELECT * FROM panels WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  const now = new Date();
  const enriched = panels.map(p => ({
    ...p,
    is_expired: p.expires_at ? new Date(p.expires_at) < now : false,
  }));
  res.json({ panels: enriched });
});

app.post('/api/panel/credentials', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { panel_id, password } = req.body;
  if (!panel_id || !password) return res.status(400).json({ error: 'panel_id and password required' });
  // Verify user password
  if (user.password) {
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  }
  const [panel] = await sql`SELECT * FROM panels WHERE id = ${parseInt(panel_id)} AND user_id = ${user.id}`;
  if (!panel) return res.status(404).json({ error: 'Panel not found' });
  res.json({
    credentials: {
      panel_url: 'https://public.mzazi.shop',
      username: panel.ptero_username,
      password: panel.ptero_password || '(saved)',
      email: panel.ptero_email,
    },
  });
});

// ─── Inquiries ────────────────────────────────────────────────
app.get('/api/inquiries', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const inquiries = await sql`
    SELECT * FROM inquiries WHERE user_id = ${user.id} ORDER BY created_at DESC
  `;
  res.json({ inquiries });
});

app.post('/api/inquiries', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
  const [inq] = await sql`
    INSERT INTO inquiries (user_id, user_email, user_name, subject, message)
    VALUES (${user.id}, ${user.email}, ${user.fullname || user.email}, ${subject}, ${message})
    RETURNING id
  `;
  await sql`
    INSERT INTO inquiry_messages (inquiry_id, sender, message)
    VALUES (${inq.id}, 'user', ${message})
  `;
  res.json({ message: 'Inquiry sent', id: inq.id });
});

app.get('/api/inquiries/:id', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const [inq] = await sql`SELECT * FROM inquiries WHERE id = ${parseInt(id)} AND user_id = ${user.id}`;
  if (!inq) return res.status(404).json({ error: 'Not found' });
  const msgs = await sql`
    SELECT * FROM inquiry_messages WHERE inquiry_id = ${parseInt(id)} ORDER BY created_at ASC
  `;
  res.json({ inquiry: inq, messages: msgs });
});

app.post('/api/inquiries/:id', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const [inq] = await sql`SELECT * FROM inquiries WHERE id = ${parseInt(id)} AND user_id = ${user.id}`;
  if (!inq) return res.status(404).json({ error: 'Not found' });
  await sql`
    INSERT INTO inquiry_messages (inquiry_id, sender, message)
    VALUES (${parseInt(id)}, 'user', ${message})
  `;
  await sql`UPDATE inquiries SET status = 'open', updated_at = NOW() WHERE id = ${parseInt(id)}`;
  res.json({ message: 'Sent' });
});

// ─── Testimonials ─────────────────────────────────────────────
app.get('/api/testimonials', async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(50, parseInt(req.query.limit) || 6);
  const [count] = await sql`SELECT COUNT(*) AS c FROM testimonials WHERE approved = true`;
  const rows = await sql`
    SELECT * FROM testimonials WHERE approved = true ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;
  res.json({ testimonials: rows, total: parseInt(count.c) });
});

app.post('/api/testimonials', async (req, res) => {
  const { name, rating, message } = req.body;
  if (!name || !rating || !message) return res.status(400).json({ error: 'All fields required' });
  const [t] = await sql`
    INSERT INTO testimonials (name, rating, message) VALUES (${name}, ${parseInt(rating)}, ${message})
    RETURNING *
  `;
  res.status(201).json({ testimonial: t });
});

// ─── Vouchers ──────────────────────────────────────────────────
app.post('/api/vouchers/redeem', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  const upper = code.trim().toUpperCase();
  const [v] = await sql`SELECT * FROM voucher_codes WHERE code = ${upper}`;
  if (!v) return res.status(404).json({ error: 'Invalid code' });
  if (v.status !== 'active') return res.status(400).json({ error: 'Voucher already used' });
  await sql`UPDATE voucher_codes SET status = 'used', used_by = ${user.id}, used_at = NOW() WHERE id = ${v.id}`;
  await sql`
    INSERT INTO wallet (user_id, balance) VALUES (${user.id}, ${parseFloat(v.amount)})
    ON CONFLICT (user_id) DO UPDATE SET balance = wallet.balance + ${parseFloat(v.amount)}
  `;
  await sql`
    INSERT INTO wallet_transactions (user_id, type, amount, reference, description, status)
    VALUES (${user.id}, 'deposit', ${parseFloat(v.amount)}, ${'VOUCHER-' + upper}, 'Voucher top-up', 'success')
  `;
  const [w] = await sql`SELECT balance FROM wallet WHERE user_id = ${user.id}`;
  res.json({ message: 'Voucher redeemed', amount: parseFloat(v.amount), newBalance: parseFloat(w.balance) });
});

// ─── Admin ─────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ role: 'admin', email }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

app.get('/api/admin/me', async (req, res) => {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ admin });
});

app.get('/api/admin/users', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const users = await sql`
    SELECT u.*, COALESCE(w.balance, 0) AS wallet_balance
    FROM users u LEFT JOIN wallet w ON w.user_id = u.id ORDER BY u.created_at DESC
  `;
  res.json({ users });
});

app.get('/api/admin/inquiries', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const inquiries = await sql`
    SELECT i.*, u.email AS user_email, u.fullname AS user_name
    FROM inquiries i LEFT JOIN users u ON u.id = i.user_id
    ORDER BY i.created_at DESC
  `;
  res.json({ inquiries });
});

app.patch('/api/admin/inquiries', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { id, admin_reply, status } = req.body;
  if (!id || !admin_reply) return res.status(400).json({ error: 'id and reply required' });
  await sql`
    UPDATE inquiries SET admin_reply = ${admin_reply}, status = ${status || 'replied'}, replied_at = NOW(), updated_at = NOW()
    WHERE id = ${parseInt(id)}
  `;
  await sql`
    INSERT INTO inquiry_messages (inquiry_id, sender, message)
    VALUES (${parseInt(id)}, 'admin', ${admin_reply})
  `;
  res.json({ message: 'Reply sent' });
});

app.delete('/api/admin/inquiries', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.body;
  await sql`UPDATE inquiries SET status = 'closed', updated_at = NOW() WHERE id = ${parseInt(id)}`;
  res.json({ message: 'Closed' });
});

app.get('/api/admin/packages', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const pkgs = await sql`SELECT * FROM packages ORDER BY sort_order ASC`;
  res.json({ packages: pkgs });
});

app.post('/api/admin/packages', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name, price, cpu, ram, disk, description, popular, accent, active, sort_order, expires_after_hours } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price required' });
  const [pkg] = await sql`
    INSERT INTO packages (name, price, cpu, ram, disk, description, popular, accent, active, sort_order, expires_after_hours)
    VALUES (${name}, ${parseFloat(price)}, ${parseInt(cpu)||0}, ${parseInt(ram)||0}, ${parseInt(disk)||0},
            ${description||''}, ${!!popular}, ${accent||'#2563eb'}, ${active!==false}, ${parseInt(sort_order)||0}, ${expires_after_hours ? parseInt(expires_after_hours) : null})
    RETURNING *
  `;
  res.status(201).json({ package: pkg });
});

app.put('/api/admin/packages/:id', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { name, price, cpu, ram, disk, description, popular, accent, active, sort_order, expires_after_hours } = req.body;
  const [pkg] = await sql`
    UPDATE packages SET
      name = ${name}, price = ${parseFloat(price)}, cpu = ${parseInt(cpu)||0}, ram = ${parseInt(ram)||0},
      disk = ${parseInt(disk)||0}, description = ${description||''}, popular = ${!!popular},
      accent = ${accent||'#2563eb'}, active = ${active!==false}, sort_order = ${parseInt(sort_order)||0},
      expires_after_hours = ${expires_after_hours ? parseInt(expires_after_hours) : null}
    WHERE id = ${parseInt(id)} RETURNING *
  `;
  res.json({ package: pkg });
});

app.delete('/api/admin/packages/:id', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  await sql`DELETE FROM packages WHERE id = ${parseInt(id)}`;
  res.json({ success: true });
});

app.post('/api/admin/packages/restore-defaults', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  await sql`DELETE FROM packages`;
  await sql`ALTER SEQUENCE packages_id_seq RESTART WITH 1`;
  const defaults = [
    ['Starter', 50, 20, 512, 2048, 'Perfect for small bots', false, '#1e3a8a', 1],
    ['Standard', 75, 50, 1024, 5120, 'Great for games & bots', true, '#2563eb', 2],
    ['Premium', 100, 100, 5120, 10240, 'High-performance servers', false, '#1d4ed8', 3],
    ['Ultimate', 120, 0, 0, 0, 'No limits. Maximum performance.', false, '#4f46e5', 4],
  ];
  for (const d of defaults) {
    await sql`
      INSERT INTO packages (name, price, cpu, ram, disk, description, popular, accent, sort_order)
      VALUES (${d[0]}, ${d[1]}, ${d[2]}, ${d[3]}, ${d[4]}, ${d[5]}, ${d[6]}, ${d[7]}, ${d[8]})
    `;
  }
  res.json({ message: 'Defaults restored' });
});

app.get('/api/admin/transactions', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const txns = await sql`
    SELECT wt.*, u.email AS user_email FROM wallet_transactions wt JOIN users u ON u.id = wt.user_id ORDER BY wt.created_at DESC LIMIT 500
  `;
  const orders = await sql`
    SELECT o.*, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 500
  `;
  const [stats] = await sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0) AS total_revenue,
      COUNT(*) FILTER (WHERE status='completed') AS completed_orders,
      COUNT(*) FILTER (WHERE status='pending') AS pending_orders
    FROM orders
  `;
  res.json({ transactions: txns, orders, stats });
});

app.get('/api/admin/vouchers', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const vouchers = await sql`
    SELECT v.*, u.email AS used_by_email FROM voucher_codes v LEFT JOIN users u ON u.id = v.used_by ORDER BY v.created_at DESC
  `;
  res.json({ vouchers });
});

app.post('/api/admin/vouchers', async (req, res) => {
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { code, amount } = req.body;
  if (!code || code.length !== 6) return res.status(400).json({ error: 'Code must be 6 characters' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const upper = code.trim().toUpperCase();
  const exist = await sql`SELECT id FROM voucher_codes WHERE code = ${upper}`;
  if (exist.length) return res.status(409).json({ error: 'Code already exists' });
  const [v] = await sql`
    INSERT INTO voucher_codes (code, amount, status, created_by)
    VALUES (${upper}, ${parseFloat(amount)}, 'active', ${req.admin?.email || 'admin'})
    RETURNING *
  `;
  res.json({ voucher: v });
});

// ─── Serve frontend ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});