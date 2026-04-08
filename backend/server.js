'use strict';

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path    = require('path');
require('dotenv').config();

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'karyoscan-dev-secret-change-in-production';
const JWT_EXPIRY = '12h';

// ── DATABASE ─────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'karyoscan.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS institutions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    cnpj          TEXT,
    contact_name  TEXT,
    contact_email TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    institution_id INTEGER NOT NULL REFERENCES institutions(id),
    plan           TEXT    NOT NULL DEFAULT 'profissional',
    price_brl      REAL,
    start_date     TEXT    NOT NULL,
    end_date       TEXT    NOT NULL,
    max_users      INTEGER NOT NULL DEFAULT 10,
    is_active      INTEGER NOT NULL DEFAULT 1,
    notes          TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    institution_id INTEGER REFERENCES institutions(id),
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL UNIQUE,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'user',
    is_active      INTEGER NOT NULL DEFAULT 1,
    last_login     TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed superadmin on first run
const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1").get();
if (!existingAdmin) {
  const adminEmail = process.env.ADMIN_EMAIL    || 'admin@karyoscan.com.br';
  const adminPass  = process.env.ADMIN_PASSWORD || 'KaryoScan@2026!';
  const hash = bcrypt.hashSync(adminPass, 12);
  db.prepare(
    "INSERT INTO users (institution_id, name, email, password_hash, role) VALUES (NULL, 'Super Admin', ?, ?, 'superadmin')"
  ).run(adminEmail, hash);
  console.log('[KaryoScan] Superadmin criado:', adminEmail);
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function getActiveLicense(institutionId) {
  return db.prepare(`
    SELECT *, CAST(julianday(end_date) - julianday('now') AS INTEGER) AS days_left
    FROM licenses
    WHERE institution_id = ? AND is_active = 1 AND end_date >= date('now')
    ORDER BY end_date DESC LIMIT 1
  `).get(institutionId);
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    next();
  });
}

// ── APP ───────────────────────────────────────────────────────────────────────

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:' + PORT];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origem não permitida.'));
  },
  credentials: true
}));
app.use(express.json({ limit: '512kb' }));

// Serve frontend static files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

  const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1").get(email.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  // For regular users, verify active license
  if (user.role !== 'superadmin' && user.institution_id) {
    const license = getActiveLicense(user.institution_id);
    if (!license) {
      return res.status(403).json({ error: 'Licença expirada ou inativa. Entre em contato com o suporte: contato@karyoscan.com.br' });
    }
  }

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const payload = {
    id:             user.id,
    name:           user.name,
    email:          user.email,
    role:           user.role,
    institution_id: user.institution_id
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.json({ valid: true, user: req.user });
  }

  if (!req.user.institution_id) {
    return res.json({ valid: true, user: req.user });
  }

  const license = getActiveLicense(req.user.institution_id);
  if (!license) {
    return res.status(403).json({ error: 'Licença expirada.', valid: false });
  }

  res.json({
    valid:    true,
    user:     req.user,
    daysLeft: license.days_left,
    plan:     license.plan
  });
});

// ── ADMIN: INSTITUTIONS ───────────────────────────────────────────────────────

app.get('/api/admin/institutions', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      i.*,
      l.plan, l.end_date, l.price_brl, l.max_users,
      (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role != 'superadmin' AND u.is_active = 1) AS user_count
    FROM institutions i
    LEFT JOIN licenses l ON l.institution_id = i.id AND l.is_active = 1 AND l.end_date >= date('now')
    ORDER BY i.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

app.post('/api/admin/institutions', requireAdmin, (req, res) => {
  const { name, cnpj, contact_name, contact_email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome da instituição é obrigatório.' });
  const r = db.prepare(
    'INSERT INTO institutions (name, cnpj, contact_name, contact_email) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), cnpj || null, contact_name || null, contact_email || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── ADMIN: LICENSES ───────────────────────────────────────────────────────────

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, i.name AS institution_name
    FROM licenses l
    JOIN institutions i ON l.institution_id = i.id
    ORDER BY l.end_date DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/licenses', requireAdmin, (req, res) => {
  const { institution_id, plan, price_brl, start_date, end_date, max_users, notes } = req.body || {};
  if (!institution_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'institution_id, start_date e end_date são obrigatórios.' });
  }
  // Deactivate previous active license for this institution
  db.prepare("UPDATE licenses SET is_active = 0 WHERE institution_id = ? AND is_active = 1").run(institution_id);
  const r = db.prepare(
    'INSERT INTO licenses (institution_id, plan, price_brl, start_date, end_date, max_users, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(institution_id, plan || 'profissional', price_brl || null, start_date, end_date, max_users || 10, notes || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── ADMIN: USERS ──────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login, u.created_at,
           i.name AS institution_name
    FROM users u
    LEFT JOIN institutions i ON u.institution_id = i.id
    WHERE u.role != 'superadmin'
    ORDER BY u.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { institution_id, name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  const hash = bcrypt.hashSync(password, 12);
  try {
    const r = db.prepare(
      'INSERT INTO users (institution_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
    ).run(institution_id || null, name.trim(), email.trim().toLowerCase(), hash, role || 'user');
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ error: 'E-mail já cadastrado.' });
    throw e;
  }
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body || {};
  db.prepare('UPDATE users SET is_active = ? WHERE id = ? AND role != ?').run(is_active ? 1 : 0, id, 'superadmin');
  res.json({ ok: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const stats = {
    totalInstitutions:  db.prepare('SELECT COUNT(*) AS c FROM institutions').get().c,
    activeInstitutions: db.prepare("SELECT COUNT(DISTINCT institution_id) AS c FROM licenses WHERE is_active=1 AND end_date >= date('now')").get().c,
    expiringIn30:       db.prepare("SELECT COUNT(*) AS c FROM licenses WHERE is_active=1 AND end_date >= date('now') AND julianday(end_date)-julianday('now') <= 30").get().c,
    totalUsers:         db.prepare("SELECT COUNT(*) AS c FROM users WHERE role != 'superadmin' AND is_active = 1").get().c,
    totalRevenue:       db.prepare('SELECT COALESCE(SUM(price_brl), 0) AS c FROM licenses').get().c
  };
  const expiring = db.prepare(`
    SELECT l.*, i.name AS institution_name,
           julianday(l.end_date) - julianday('now') AS days_left
    FROM licenses l
    JOIN institutions i ON l.institution_id = i.id
    WHERE l.is_active = 1 AND julianday(l.end_date) - julianday('now') <= 60
    ORDER BY l.end_date ASC
  `).all();
  res.json({ stats, expiring });
});

// ── 404 & ERROR ───────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[KaryoScan] Servidor rodando em http://localhost:${PORT}`);
  console.log(`[KaryoScan] Admin:     http://localhost:${PORT}/admin.html`);
  console.log(`[KaryoScan] Landing:   http://localhost:${PORT}/landing.html`);
});
