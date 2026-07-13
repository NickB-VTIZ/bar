const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

const APP_VERSION = '5.47.1';
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
let messagebird = null; // initialized after settings load

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/zomerbar.db';
// Default admin password — change via ADMIN_PASSWORD env var or in settings
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zomerbar2025';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Database ─────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sumup_id    TEXT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'Overige',
    price       REAL NOT NULL,
    icon        TEXT NOT NULL DEFAULT '🍺',
    vat_type    TEXT NOT NULL DEFAULT 'drinks',
    stock       INTEGER NOT NULL DEFAULT -1,
    low_stock   INTEGER NOT NULL DEFAULT 5,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    order_number  INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    amount        REAL NOT NULL DEFAULT 0,
    method        TEXT NOT NULL DEFAULT 'sumup',
    sumup_checkout_id TEXT,
    sumup_tx_id   TEXT,
    note          TEXT DEFAULT '',
    phone         TEXT DEFAULT '',
    table_ref     TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER REFERENCES products(id),
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '🍺',
    price       REAL NOT NULL,
    qty         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stock_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL,
    delta       INTEGER NOT NULL,
    reason      TEXT NOT NULL DEFAULT 'sale',
    order_id    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sumup_sales (
    tx_ref      TEXT PRIMARY KEY,
    date        TEXT,
    amount      REAL,
    items_json  TEXT,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tabs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS staff_shifts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    name        TEXT NOT NULL,
    hours       REAL NOT NULL DEFAULT 0,
    hourly_rate REAL NOT NULL DEFAULT 0,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS overhead_costs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT NOT NULL,
    category      TEXT NOT NULL,      -- 'elektriciteit','afval','administratie','huur','verzekering','overig'
    description   TEXT,
    amount_incl   REAL NOT NULL,       -- bedrag incl btw (wat je betaald hebt)
    vat_rate      REAL NOT NULL DEFAULT 21,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dagkasboek: startbedragen, manuele cash uitgaven en extra inkomsten
  CREATE TABLE IF NOT EXISTS cash_journal_entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT NOT NULL,
    type          TEXT NOT NULL,      -- 'start' (startbedrag) | 'expense' (cash uitgave) | 'income' (extra cash-inkomst)
    description   TEXT DEFAULT '',
    amount        REAL NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cash_journal_date ON cash_journal_entries(date);
`);

// ── Database migraties ───────────────────────────────────────────
// Voeg ontbrekende kolommen toe zonder de database te wissen
const migrations = [
  `ALTER TABLE orders ADD COLUMN phone TEXT DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN table_ref TEXT DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN sumup_tx_id TEXT`,
  `ALTER TABLE orders ADD COLUMN mollie_payment_id TEXT`,
  `ALTER TABLE products ADD COLUMN sumup_id TEXT`,
  `ALTER TABLE products ADD COLUMN low_stock INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN vat_rate REAL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN image_url TEXT DEFAULT ''`,
  `ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''`,
  `ALTER TABLE products ADD COLUMN hidden INTEGER DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN sku TEXT DEFAULT ''`,
  `ALTER TABLE products ADD COLUMN crate_size INTEGER`,
  `ALTER TABLE orders ADD COLUMN tab_id INTEGER`,
  `ALTER TABLE orders ADD COLUMN gift REAL DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN cash_paid INTEGER DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN invoice_billit_id TEXT`,
  `ALTER TABLE orders ADD COLUMN invoice_customer_name TEXT`,
  `ALTER TABLE orders ADD COLUMN is_staff INTEGER DEFAULT 0`,
  `ALTER TABLE tabs ADD COLUMN is_staff INTEGER DEFAULT 0`,
  `ALTER TABLE overhead_costs ADD COLUMN period TEXT DEFAULT 'maand'`,
];

migrations.forEach(sql => {
  try { db.exec(sql); } catch(e) {
    // Kolom bestaat al — geen probleem
    if (!e.message.includes('duplicate column')) { /* negeer */ }
  }
});

// Opkuis: verwijder oude WK-scorebord instellingen (feature verwijderd in v5.44)
try {
  db.prepare("DELETE FROM settings WHERE key IN ('scoreboard','wkMode','wkApiKey','wkFavoriteTeam')").run();
} catch(_) {}

// Seed default products if empty
if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
  const ins = db.prepare(`INSERT INTO products (name,category,price,icon,vat_type,stock,sort_order) VALUES (?,?,?,?,?,?,?)`);
  [
    ['Pils',          'Bieren',    2.50, '🍺', 'drinks', 50, 1],
    ['Tripel',        'Bieren',    3.50, '🍺', 'drinks', 30, 2],
    ['Fruitbier',     'Bieren',    3.00, '🍻', 'drinks', 24, 3],
    ['Cola',          'Soft',      2.00, '🥤', 'drinks', 40, 4],
    ['Water',         'Soft',      1.50, '💧', 'drinks', 48, 5],
    ['Ice Tea',       'Soft',      2.50, '🧃', 'drinks', 36, 6],
    ['Aperol Spritz', 'Cocktails', 7.00, '🍹', 'drinks', 20, 7],
    ['Mojito',        'Cocktails', 8.00, '🍹', 'drinks', 15, 8],
    ['Toast HAC',     'Eten',      5.50, '🥪', 'food',   20, 9],
    ['Plankje',       'Eten',      9.00, '🧀', 'food',   10, 10],
    ['Frietjes',      'Eten',      3.50, '🍟', 'food',   25, 11],
  ].forEach(p => ins.run(...p));
}

// ── Order number counter ─────────────────────────────────────────
let orderNumCounter = (() => {
  const r = db.prepare("SELECT MAX(order_number) as m FROM orders").get();
  return (r?.m || 0) + 1;
})();

function nextOrderNumber() { return orderNumCounter++; }
function generateOrderId() { return 'ZB-' + Date.now() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(); }

// ── Express + WS ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

wss.on('connection', ws => {
  clients.add(ws);
  // Send current active orders on connect
  ws.send(JSON.stringify({ type: 'init', orders: getActiveOrders() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Helpers ──────────────────────────────────────────────────────
function getActiveOrders() {
  const orders = db.prepare(`
    SELECT o.* FROM orders o
    WHERE o.status NOT IN ('archived','cancelled')
    ORDER BY CASE o.status
      WHEN 'pending' THEN 0 WHEN 'paid' THEN 1
      WHEN 'preparing' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END,
    o.created_at ASC
  `).all();
  return orders.map(hydrate);
}

function hydrate(o) {
  return {
    ...o,
    items: db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id),
  };
}

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

// ── Twilio SMS ───────────────────────────────────────────────────
function getTwilioClient() {
  const accountSid = getSetting('twilioAccountSid');
  const authToken  = getSetting('twilioAuthToken');
  if (!accountSid || !authToken) return null;
  try { return require('twilio')(accountSid, authToken); } catch { return null; }
}

function normalizePhone(phone) {
  let n = phone.replace(/\s+/g, '');
  if (n.startsWith('0') && !n.startsWith('00')) n = '+32' + n.slice(1);
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (!n.startsWith('+')) n = '+32' + n;
  return n;
}

async function sendSMS(phone, message) {
  const client = getTwilioClient();
  if (!client) return { skipped: true, reason: 'Geen Twilio-sleutels ingesteld' };
  const to = normalizePhone(phone);
  const messagingServiceSid = getSetting('twilioMessagingServiceSid');
  const payload = { body: message, to };
  if (messagingServiceSid && messagingServiceSid.startsWith('MG')) {
    // Messaging Service kiest zelf de beste afzender (nummer of merknaam)
    payload.messagingServiceSid = messagingServiceSid;
  } else {
    payload.from = getSetting('twilioFrom') || getSetting('smsOriginator') || 'Boerderbij';
  }
  const msg = await client.messages.create(payload);
  console.log('SMS verstuurd via Twilio naar', to, '— SID:', msg.sid);
  return msg;
}

async function notifyOrderReady(order) {
  if (!order.phone) return;
  const barName = getSetting('barName') || 'Zomerbar';
  // Aanpasbare template met placeholders {bar}, {nummer}, {totaal}
  const template = getSetting('smsTemplate')
    || '{bar}: Bestelling #{nummer} is klaar! Haal op aan de bar. Smakelijk! ☀️';
  const amtFmt = '€ ' + (order.amount || 0).toFixed(2).replace('.', ',');
  const msg = template
    .replace(/\{bar\}/g, barName)
    .replace(/\{nummer\}/g, order.order_number)
    .replace(/\{totaal\}/g, amtFmt);
  try { await sendSMS(order.phone, msg); }
  catch (e) { console.error('SMS mislukt:', e.message); }
}

// ── Mollie Bancontact ────────────────────────────────────────────
function getMollieClient() {
  const key = getSetting('mollieKey');
  if (!key) return null;
  try {
    const { createMollieClient } = require('@mollie/api-client');
    return createMollieClient({ apiKey: key });
  } catch { return null; }
}

async function createMolliePayment(order, redirectUrl) {
  const mollie = getMollieClient();
  if (!mollie) return null;
  const barName = getSetting('barName') || 'Zomerbar';
  const siteUrl = getSetting('siteUrl') || '';
  // Basis-URL bepalen (van client of instelling), dan ALTIJD ?order=<id> toevoegen
  const base = (redirectUrl || siteUrl || '').replace(/\?.*$/, '').replace(/\/+$/, '');
  const finalRedirect = `${base || siteUrl}/?order=${order.id}`;
  const payload = {
    amount: { currency: 'EUR', value: order.amount.toFixed(2) },
    description: `${barName} — Bestelling #${order.order_number}`,
    redirectUrl: finalRedirect,
    metadata: { order_id: order.id, order_number: String(order.order_number) },
  };
  // Only add webhook if we have a public https URL (Mollie rejects localhost)
  if (siteUrl && siteUrl.startsWith('https://')) {
    payload.webhookUrl = `${siteUrl}/api/mollie/webhook`;
  }
  // Prefer Bancontact, but only set it if explicitly — otherwise Mollie shows all enabled methods
  const forceMethod = getSetting('mollieMethod');
  if (forceMethod) payload.method = forceMethod;
  const payment = await mollie.payments.create(payload);
  return payment;
}

async function checkMolliePayment(paymentId) {
  const mollie = getMollieClient();
  if (!mollie) return null;
  return mollie.payments.get(paymentId);
}

// ── SumUp Online (Hosted Checkout) ───────────────────────────────
async function sumupRequest(method, apiPath, body) {
  const apiKey = getSetting('sumupApiKey');
  if (!apiKey) throw new Error('Geen SumUp API-sleutel ingesteld');
  const r = await fetch('https://api.sumup.com' + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.message) ? data.message : ('SumUp fout ' + r.status));
  return data;
}

async function createSumupCheckout(order, redirectUrl) {
  const merchantCode = getSetting('sumupMerchantCode');
  if (!merchantCode) throw new Error('Geen SumUp merchant code ingesteld');
  const barName = getSetting('barName') || 'Zomerbar';
  const siteUrl = getSetting('siteUrl') || '';
  // Basis-URL bepalen (van client of instelling), dan ALTIJD ?order=<id> toevoegen
  const base = (redirectUrl || siteUrl || '').replace(/\?.*$/, '').replace(/\/+$/, '');
  const finalRedirect = `${base || siteUrl}/?order=${order.id}`;
  const payload = {
    checkout_reference: order.id,
    amount: parseFloat(order.amount.toFixed(2)),
    currency: 'EUR',
    merchant_code: merchantCode,
    description: `${barName} — Bestelling #${order.order_number}`,
    hosted_checkout: { enabled: true },
    redirect_url: finalRedirect,
  };
  // Webhook voor automatische bevestiging (enkel bij geldige https-URL)
  if (siteUrl && siteUrl.startsWith('https://')) {
    payload.return_url = `${siteUrl}/api/sumup/webhook`;
  }
  const checkout = await sumupRequest('POST', '/v0.1/checkouts', payload);
  return checkout;
}

// Diagnostiek: welke betaalmethodes biedt SumUp aan voor dit account?
async function getSumupPaymentMethods(amount = 1.0) {
  const merchantCode = getSetting('sumupMerchantCode');
  if (!merchantCode) throw new Error('Geen SumUp merchant code ingesteld');
  // Maak tijdelijke checkout
  const checkout = await sumupRequest('POST', '/v0.1/checkouts', {
    checkout_reference: 'pm-probe-' + Date.now(),
    amount: parseFloat(amount.toFixed(2)),
    currency: 'EUR',
    merchant_code: merchantCode,
    description: 'Payment method probe',
  });
  const methods = await sumupRequest('GET', `/v0.1/checkouts/${checkout.id}/payment-methods`);
  // Ruim de probe op
  try { await sumupRequest('DELETE', `/v0.1/checkouts/${checkout.id}`); } catch(_) {}
  return { checkoutId: checkout.id, methods };
}

async function checkSumupCheckout(checkoutId) {
  return sumupRequest('GET', `/v0.1/checkouts/${checkoutId}`);
}
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function getAdminPasswordHash() {
  const stored = getSetting('adminPasswordHash');
  if (stored) return stored;
  // First run: hash the default password
  return hashPassword(DEFAULT_ADMIN_PASSWORD);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 dagen
  db.prepare('INSERT INTO sessions (token,expires_at) VALUES (?,?)').run(token, expires);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const s = db.prepare("SELECT * FROM sessions WHERE token=? AND expires_at > datetime('now')").get(token);
  return !!s;
}

// Cleanup expired sessions periodically
setInterval(() => {
  try { db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); } catch {}
}, 3600 * 1000);

// Middleware: protect admin endpoints
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!isValidSession(token)) return res.status(401).json({ error: 'Niet ingelogd', needsAuth: true });
  next();
}

// ── Stock helpers ────────────────────────────────────────────────
function deductStock(items, orderId) {
  const upd = db.prepare('UPDATE products SET stock = MAX(-1, stock - ?) WHERE id=? AND stock >= 0');
  const log = db.prepare('INSERT INTO stock_log (product_id,delta,reason,order_id) VALUES (?,?,?,?)');
  items.forEach(item => {
    if (item.product_id) {
      upd.run(item.qty, item.product_id);
      log.run(item.product_id, -item.qty, 'sale', orderId);
    }
  });
  // Broadcast low stock alerts
  const low = db.prepare('SELECT * FROM products WHERE stock >= 0 AND stock <= low_stock AND active=1').all();
  if (low.length) broadcast('low_stock', { products: low });
}

// ── SumUp API ────────────────────────────────────────────────────
async function sumupRequest(method, path, body) {
  const key = getSetting('sumupKey');
  if (!key) throw new Error('Geen SumUp API-sleutel ingesteld');
  const r = await fetch('https://api.sumup.com' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || data.error_message || 'SumUp fout');
  return data;
}

// ── REST API ─────────────────────────────────────────────────────

// Auth
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Wachtwoord vereist' });
  if (hashPassword(password) !== getAdminPasswordHash()) {
    return res.status(401).json({ error: 'Verkeerd wachtwoord' });
  }
  const token = createSession();
  res.json({ token });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  res.json({ valid: isValidSession(token) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Minstens 4 tekens' });
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
    .run('adminPasswordHash', JSON.stringify(hashPassword(newPassword)));
  res.json({ ok: true });
});

// Products
app.get('/api/products', (req, res) => {
  // Admin ziet ook verborgen producten (?admin=1), klant niet
  const isAdmin = req.query.admin === '1';
  const sql = isAdmin
    ? 'SELECT * FROM products WHERE active=1'
    : 'SELECT * FROM products WHERE active=1 AND hidden=0';
  const products = db.prepare(sql).all();
  // Bereken marge per product en sorteer hoogste marge bovenaan
  const withMargin = products.map(p => {
    const noVat = p.vat_rate === -1;
    const vatR = noVat ? 0 : (p.vat_rate != null && p.vat_rate >= 0 ? p.vat_rate : (p.vat_type === 'food' ? 12 : 6));
    const excl = noVat ? p.price : p.price / (1 + vatR/100);
    const marginPct = (p.cost_price > 0 && excl > 0) ? ((excl - p.cost_price) / excl) : -1;
    return { ...p, _margin: marginPct };
  });
  // Sorteer: hoogste marge eerst; producten zonder kostprijs (marge -1) onderaan
  withMargin.sort((a, b) => {
    if (b._margin !== a._margin) return b._margin - a._margin;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  withMargin.forEach(p => delete p._margin);
  res.json(withMargin);
});

// Verberg/toon product (snel togglen)
app.patch('/api/products/:id/hidden', requireAuth, (req, res) => {
  const { hidden } = req.body;
  const o = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Product niet gevonden' });
  db.prepare('UPDATE products SET hidden=? WHERE id=?').run(hidden ? 1 : 0, req.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  broadcast('product_updated', { product: p });
  res.json(p);
});

// ── SumUp CSV import ─────────────────────────────────────────────
// Parseert een SumUp items-export CSV en voegt producten toe
// ── Export producten naar SumUp CSV-formaat ──────────────────────
app.get('/api/products/export-sumup', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY category,name').all();
  // SumUp import header (vereenvoudigd maar compatibel) — incl. SKU
  const header = ['Item name','Description','Price','Cost price','Tax rate (%)','Category','Track inventory? (Yes/No)','Quantity','SKU','Item id (Do not change)'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Genereer een SKU voor producten die er nog geen hebben (en sla op)
  const setSku = db.prepare('UPDATE products SET sku=? WHERE id=?');
  const existingSkus = new Set(products.map(p => (p.sku||'').trim()).filter(Boolean));
  const slug = (name) => (name||'item').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,12) || 'ITEM';
  const genSku = (p) => {
    let base = 'ZB-' + slug(p.name);
    let candidate = base, n = 1;
    while (existingSkus.has(candidate)) { candidate = base + '-' + (++n); }
    existingSkus.add(candidate);
    return candidate;
  };
  const lines = [header.join(',')];
  products.forEach(p => {
    const vatR = p.vat_rate === -1 ? 0 : (p.vat_rate != null && p.vat_rate >= 0 ? p.vat_rate : (p.vat_type === 'food' ? 12 : 6));
    const tracks = p.stock >= 0 ? 'Yes' : 'No';
    const qty = p.stock >= 0 ? p.stock : 0;
    let sku = (p.sku || '').trim();
    if (!sku) { sku = genSku(p); setSku.run(sku, p.id); } // genereer + bewaar
    lines.push([
      esc(p.name), esc(p.description || ''), p.price.toFixed(2),
      p.cost_price ? p.cost_price.toFixed(2) : '',
      vatR.toFixed(2), esc(p.category),
      tracks, qty, esc(sku), esc(p.sumup_id || ''),
    ].join(','));
  });
  const csv = lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="zomerbar-producten-sumup.csv"');
  res.send(csv);
});

// Diagnostiek: toont welke SumUp betaalmethodes beschikbaar zijn
app.get('/api/sumup/payment-methods', requireAuth, async (req, res) => {
  try {
    const result = await getSumupPaymentMethods(parseFloat(req.query.amount) || 1.0);
    res.json(result);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/products/import-sumup', requireAuth, (req, res) => {
  const { rows } = req.body; // array of parsed CSV row objects from frontend
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Geen rijen ontvangen' });

  // Emoji per categorie (Nederlandse SumUp categorieën)
  const catEmoji = {
    'bier': '🍺', 'alcoholvrij': '🍺', 'frisdrank': '🥤', 'wijn': '🍷',
    'coctails': '🍹', 'cocktails': '🍹', 'mocktails': '🍹',
    'warme dranken': '☕', 'homemade': '🧃', 'food': '🍿',
  };

  const maxOrd0 = db.prepare('SELECT MAX(sort_order) as m FROM products').get().m || 0;
  const insert = db.prepare(`INSERT INTO products (name,category,price,icon,vat_type,stock,low_stock,cost_price,vat_rate,sumup_id,image_url,description,sku,sort_order,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const findBySumup = db.prepare('SELECT * FROM products WHERE sumup_id=?');
  const updateExisting = db.prepare(`UPDATE products SET name=?,category=?,price=?,cost_price=?,vat_rate=?,vat_type=?,icon=?,image_url=?,stock=?,description=?,sku=?,active=1 WHERE sumup_id=?`);

  let added = 0, updated = 0, failed = 0;
  const errors = [];
  let ord = maxOrd0;

  for (const row of rows) {
    try {
      const name = (row.name || '').trim();
      const price = parseFloat(row.price);
      if (!name || isNaN(price)) { failed++; continue; }
      const cost_price = row.cost_price ? parseFloat(row.cost_price) : 0;
      let vat_rate = row.tax_rate != null && row.tax_rate !== '' ? parseFloat(row.tax_rate) : 6;
      if (isNaN(vat_rate)) vat_rate = 6;
      const category = (row.category || 'Overige').trim();
      const vat_type = vat_rate >= 12 ? 'food' : 'drinks';
      const catKey = category.toLowerCase();
      const icon = catEmoji[catKey] || '🍺';
      const sumup_id = row.item_id || null;
      const image_url = (row.image_url || '').trim();
      const description = (row.description || '').trim();
      const sku = (row.sku || '').trim();
      // Track inventory? quantity — SumUp geeft de voorraad mee
      let stock = -1; // -1 = onbeperkt (geen tracking)
      if (row.track_inventory && String(row.track_inventory).toLowerCase() === 'yes') {
        const q = row.quantity != null && row.quantity !== '' ? parseInt(row.quantity) : 0;
        // SumUp gebruikt soms -1 voor "onbeperkt" ondanks tracking aan
        stock = (isNaN(q) || q < 0) ? -1 : q;
      }

      const existing = sumup_id ? findBySumup.get(sumup_id) : null;
      if (existing) {
        // Voorraad: gebruik CSV-waarde als SumUp tracking aan heeft,
        // anders behoud de bestaande voorraad (tenzij product verwijderd was → dan 0)
        const wasDeleted = existing.active === 0;
        let finalStock;
        if (stock >= 0) {
          finalStock = stock; // SumUp trackt: neem die waarde
        } else if (wasDeleted) {
          finalStock = -1; // heractiveren zonder tracking → onbeperkt
        } else {
          finalStock = existing.stock; // behoud
        }
        const finalImage = image_url || existing.image_url || '';
        const finalDesc = description || existing.description || '';
        const finalIcon = existing.icon && existing.icon !== '🍺' ? existing.icon : icon;
        const finalSku = sku || existing.sku || '';
        updateExisting.run(name, category, price, isNaN(cost_price)?0:cost_price, vat_rate, vat_type, finalIcon, finalImage, finalStock, finalDesc, finalSku, sumup_id);
        updated++;
      } else {
        ord++;
        insert.run(name, category, price, icon, vat_type, stock, 5, isNaN(cost_price)?0:cost_price, vat_rate, sumup_id, image_url, description, sku, ord);
        added++;
      }
    } catch(e) { failed++; errors.push(`${row.name}: ${e.message}`); }
  }

  const allProducts = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order,name').all();
  res.json({ ok: true, added, updated, failed, errors: errors.slice(0,10), products: allProducts });
});

// ── SumUp verkopen → voorraad aftrekken ──────────────────────────
// Preview: toont wat er afgetrokken zou worden, zonder iets te wijzigen
app.post('/api/products/import-sumup-sales/preview', requireAuth, (req, res) => {
  const { rows } = req.body; // [{ tx_ref, date, name, sumup_id, qty, amount }]
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Geen verkopen ontvangen' });

  const findBySku = db.prepare("SELECT id,name,stock,icon FROM products WHERE sku=? AND sku!=''");
  const findBySumup = db.prepare('SELECT id,name,stock,icon FROM products WHERE sumup_id=?');
  const findByName = db.prepare('SELECT id,name,stock,icon FROM products WHERE LOWER(name)=LOWER(?)');
  const alreadyDone = db.prepare('SELECT tx_ref FROM sumup_sales WHERE tx_ref=?');

  const matched = {}, unmatched = [];
  let skippedTx = 0, newTx = 0;
  const seenTx = new Set();

  for (const row of rows) {
    const txRef = (row.tx_ref || '').trim();
    // Dubbeltelling-preventie: sla al verwerkte transacties over
    if (txRef) {
      if (seenTx.has(txRef)) continue;
      seenTx.add(txRef);
      if (alreadyDone.get(txRef)) { skippedTx++; continue; }
      newTx++;
    }
    const qty = parseInt(row.qty) || 0;
    if (qty <= 0) continue;
    // Match-volgorde: SKU (betrouwbaarst) → SumUp-ID → naam
    let p = row.sku ? findBySku.get(row.sku.trim()) : null;
    if (!p && row.sumup_id) p = findBySumup.get(row.sumup_id);
    if (!p && row.name) p = findByName.get(row.name.trim());
    if (!p) { unmatched.push(row.name || row.sku || row.sumup_id || '?'); continue; }
    if (!matched[p.id]) matched[p.id] = { id: p.id, name: p.name, icon: p.icon, stock: p.stock, qty: 0 };
    matched[p.id].qty += qty;
  }

  res.json({
    matched: Object.values(matched),
    unmatched: [...new Set(unmatched)],
    skipped_transactions: skippedTx,
    new_transactions: newTx,
    has_tx_refs: rows.some(r => r.tx_ref),
  });
});

// Verwerk: trekt de voorraad af en logt de transacties
app.post('/api/products/import-sumup-sales', requireAuth, (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Geen verkopen ontvangen' });

  const findBySku = db.prepare("SELECT id,name,stock FROM products WHERE sku=? AND sku!=''");
  const findBySumup = db.prepare('SELECT id,name,stock FROM products WHERE sumup_id=?');
  const findByName = db.prepare('SELECT id,name,stock FROM products WHERE LOWER(name)=LOWER(?)');
  const alreadyDone = db.prepare('SELECT tx_ref FROM sumup_sales WHERE tx_ref=?');
  const markTx = db.prepare('INSERT OR IGNORE INTO sumup_sales (tx_ref,date,amount,items_json) VALUES (?,?,?,?)');
  const updStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=? AND stock >= 0');
  const logStock = db.prepare("INSERT INTO stock_log (product_id,delta,reason,order_id) VALUES (?,?,'sumup_sale',?)");

  const seenTx = new Set();
  const deductions = {}; // product_id → qty
  let processedTx = 0, skippedTx = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const txRef = (row.tx_ref || '').trim();
      if (txRef) {
        if (seenTx.has(txRef)) continue;
        seenTx.add(txRef);
        if (alreadyDone.get(txRef)) { skippedTx++; continue; }
      }
      const qty = parseInt(row.qty) || 0;
      if (qty <= 0) continue;
      // Match-volgorde: SKU → SumUp-ID → naam
      let p = row.sku ? findBySku.get(row.sku.trim()) : null;
      if (!p && row.sumup_id) p = findBySumup.get(row.sumup_id);
      if (!p && row.name) p = findByName.get(row.name.trim());
      if (!p) continue;
      deductions[p.id] = (deductions[p.id] || 0) + qty;
      if (txRef) {
        markTx.run(txRef, row.date || null, row.amount != null ? parseFloat(row.amount) : null, JSON.stringify({ name: row.name, qty }));
        processedTx++;
      }
    }
    // Pas aftrek toe (alleen producten met getrackte voorraad, stock >= 0)
    Object.entries(deductions).forEach(([pid, qty]) => {
      updStock.run(qty, pid);
      logStock.run(pid, -qty, 'sumup-import');
    });
  });
  tx();

  // Low stock alerts
  const low = db.prepare('SELECT * FROM products WHERE stock >= 0 AND stock <= low_stock AND active=1').all();
  if (low.length) broadcast('low_stock', { products: low });
  const allProducts = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order,name').all();
  allProducts.forEach(p => broadcast('product_updated', { product: p }));

  res.json({
    ok: true,
    products_updated: Object.keys(deductions).length,
    total_deducted: Object.values(deductions).reduce((a,b)=>a+b,0),
    processed_transactions: processedTx,
    skipped_transactions: skippedTx,
    products: allProducts,
  });
});

app.post('/api/products', requireAuth, (req, res) => {
  const { name, description, category, price, icon, vat_type, stock, low_stock, cost_price, vat_rate, crate_size } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Naam en prijs zijn verplicht' });
  const maxOrd = db.prepare('SELECT MAX(sort_order) as m FROM products').get().m || 0;
  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');
  const finalVatRate = vat_rate != null ? parseFloat(vat_rate) : (vat_type === 'food' ? vatFood : vatDrinks);
  const r = db.prepare(`INSERT INTO products (name,description,category,price,icon,vat_type,stock,low_stock,cost_price,vat_rate,crate_size,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, description||'', category||'Overige', parseFloat(price), icon||'🍺', vat_type||'drinks', stock??-1, low_stock??5, cost_price!=null?parseFloat(cost_price):0, finalVatRate, crate_size||null, maxOrd+1);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
  broadcast('product_updated', { product: p });
  res.json(p);
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product niet gevonden' });
  const { name, description, category, price, icon, vat_type, stock, low_stock, active, cost_price, vat_rate, crate_size } = req.body;
  db.prepare(`UPDATE products SET name=?,description=?,category=?,price=?,icon=?,vat_type=?,stock=?,low_stock=?,active=?,cost_price=?,vat_rate=?,crate_size=? WHERE id=?`)
    .run(
      name ?? existing.name,
      description != null ? description : existing.description,
      category ?? existing.category,
      price != null ? parseFloat(price) : existing.price,
      icon ?? existing.icon,
      vat_type ?? existing.vat_type,
      stock != null ? stock : existing.stock,
      low_stock != null ? low_stock : existing.low_stock,
      active != null ? active : existing.active,
      cost_price != null ? parseFloat(cost_price) : existing.cost_price,
      vat_rate != null ? parseFloat(vat_rate) : existing.vat_rate,
      crate_size !== undefined ? (crate_size||null) : existing.crate_size,
      req.params.id
    );
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  broadcast('product_updated', { product: p });
  res.json(p);
});

app.patch('/api/products/:id/stock', requireAuth, (req, res) => {
  const { stock, reason } = req.body;
  const existing = db.prepare('SELECT stock FROM products WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Niet gevonden' });
  const delta = stock - existing.stock;
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(stock, req.params.id);
  // Log de aanpassing (voor leveringen en handmatige correcties)
  if (delta !== 0) {
    db.prepare('INSERT INTO stock_log (product_id,delta,reason) VALUES (?,?,?)')
      .run(req.params.id, delta, reason || 'manual');
  }
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  broadcast('product_updated', { product: p });
  res.json(p);
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  broadcast('product_deleted', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// SumUp catalog sync
app.post('/api/products/sync-sumup', requireAuth, async (req, res) => {
  try {
    const catalog = await sumupRequest('GET', '/v0.1/catalog');
    const products = catalog.items || catalog.products || [];
    const upsert = db.prepare(`
      INSERT INTO products (sumup_id,name,category,price,icon,vat_type,stock,sort_order)
      VALUES (?,?,?,?,?,?,-1,999)
      ON CONFLICT(sumup_id) DO UPDATE SET name=excluded.name,price=excluded.price
    `);
    // Add unique constraint on sumup_id if not exists
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sumup_id ON products(sumup_id) WHERE sumup_id IS NOT NULL'); } catch {}
    let synced = 0;
    products.forEach(p => {
      const price = p.price?.amount ? p.price.amount / 100 : (p.price || 0);
      upsert.run(p.id || p.product_id, p.name, p.category?.name || 'Overige', price, '🍺', 'drinks');
      synced++;
    });
    const all = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order').all();
    broadcast('products_reloaded', { products: all });
    res.json({ synced, products: all });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Orders
app.get('/api/orders', (req, res) => res.json(getActiveOrders()));

// Historiek: alle bestellingen van een dag (incl. afgehandeld/geannuleerd)
// LET OP: moet vóór /api/orders/:id staan
app.get('/api/orders/history', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const orders = db.prepare(`
    SELECT o.*, t.name AS tab_name, t.status AS tab_status
    FROM orders o
    LEFT JOIN tabs t ON t.id = o.tab_id
    WHERE DATE(o.created_at,'localtime')=?
    ORDER BY o.created_at DESC LIMIT 300
  `).all(date);
  res.json(orders.map(o => {
    const h = hydrate(o);
    if (o.tab_name) { h.tab_name = o.tab_name; h.tab_status = o.tab_status; }
    return h;
  }));
});

app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(hydrate(o));
});

// Create order + SumUp checkout
app.post('/api/orders', async (req, res) => {
  const { items, method, note, table_ref, phone, redirect_url, gift } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Geen items' });

  // Validate stock
  for (const item of items) {
    if (item.product_id) {
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id);
      if (p && p.stock >= 0 && p.stock < item.qty) {
        return res.status(400).json({ error: `Onvoldoende stock voor ${p.name} (nog ${p.stock})` });
      }
    }
  }

  const id = generateOrderId();
  const orderNumber = nextOrderNumber();
  const giftAmount = (gift && gift > 0) ? parseFloat(gift) : 0;
  const amount = items.reduce((s, i) => s + i.price * i.qty, 0) + giftAmount;
  let molliePaymentId = null;
  let mollieCheckoutUrl = null;

  // Cash = bar-bestelling: meteen op het bord (paid) maar nog niet fysiek betaald (cash_paid=0)
  // Tab = op rekening: zelfde gedrag, gekoppeld aan een rekening
  // Staff = personeelsdrankje: gaat op de speciale "eeuwige" Personeel-rekening,
  //   status meteen 'collected' zodat het niet op het bord komt om af te vinken
  // Online (mollie/sumup) = wacht op betaling
  let tabId = req.body.tab_id ? parseInt(req.body.tab_id) : null;
  const isCash = method === 'cash';
  const isStaff = method === 'staff';
  const isTab = method === 'tab' && tabId;

  // Staff → automatisch koppelen aan de speciale personeelsrekening
  if (isStaff) {
    tabId = getOrCreateStaffTab().id;
  }

  const payMethod = isCash ? 'cash' : isTab ? 'tab' : isStaff ? 'staff' : (method || getSetting('payProvider') || 'mollie');
  // Staff-bestellingen zijn meteen 'collected' → verschijnen niet op het bord
  const status = isStaff ? 'collected' : (isCash || isTab) ? 'paid' : 'pending';

  db.prepare(`INSERT INTO orders (id,order_number,status,amount,method,note,phone,table_ref,gift,cash_paid,tab_id,is_staff)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orderNumber, status, amount, payMethod, note||'', phone||'', table_ref||'', giftAmount, isStaff?1:0, (isTab||isStaff) ? tabId : null, isStaff?1:0);

  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,name,icon,price,qty) VALUES (?,?,?,?,?,?)');
  items.forEach(i => insertItem.run(id, i.product_id||null, i.name, i.icon||'🍺', i.price, i.qty));

  // Cash/rekening/personeel: trek de voorraad meteen af
  if (isCash || isTab || isStaff) {
    deductStock(items.map(i => ({...i})), id);
  }

  // Create Mollie Bancontact payment
  let paymentError = null;
  if (payMethod === 'mollie') {
    try {
      const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
      const payment = await createMolliePayment(order, redirect_url);
      if (payment) {
        molliePaymentId = payment.id;
        mollieCheckoutUrl = payment._links.checkout?.href || payment.checkoutUrl;
        db.prepare('UPDATE orders SET mollie_payment_id=? WHERE id=?').run(molliePaymentId, id);
      } else {
        paymentError = 'Mollie is niet geconfigureerd (geen API-sleutel ingesteld in Beheer)';
      }
    } catch(e) {
      console.error('Mollie fout:', e.message);
      paymentError = 'Mollie: ' + e.message;
    }
  }

  // Create SumUp Hosted Checkout
  let sumupCheckoutUrl = null, sumupCheckoutId = null;
  if (payMethod === 'sumup') {
    try {
      const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
      const checkout = await createSumupCheckout(order, redirect_url);
      if (checkout && checkout.hosted_checkout_url) {
        sumupCheckoutId = checkout.id;
        sumupCheckoutUrl = checkout.hosted_checkout_url;
        db.prepare('UPDATE orders SET sumup_checkout_id=? WHERE id=?').run(sumupCheckoutId, id);
      } else {
        paymentError = 'SumUp checkout kon niet worden aangemaakt (controleer API-sleutel en merchant code)';
      }
    } catch(e) {
      console.error('SumUp fout:', e.message);
      paymentError = 'SumUp: ' + e.message;
    }
  }

  const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
  broadcast('order_created', { order });
  res.json({ order, mollieCheckoutUrl, molliePaymentId, sumupCheckoutUrl, sumupCheckoutId, paymentError });
});

// SumUp payment webhook / poll
app.post('/api/orders/:id/confirm-payment', async (req, res) => {
  const { sumup_tx_id } = req.body;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Niet gevonden' });

  db.prepare("UPDATE orders SET status='paid', sumup_tx_id=?, updated_at=datetime('now') WHERE id=?")
    .run(sumup_tx_id||null, req.params.id);

  // Deduct stock now that payment is confirmed
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(req.params.id);
  deductStock(items, req.params.id);

  const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id));
  broadcast('order_updated', { order });
  res.json(order);
});

// Poll SumUp checkout status (kept for compatibility)
app.get('/api/orders/:id/payment-status', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Niet gevonden' });
  if (o.status !== 'pending') return res.json({ status: o.status });

  // Check Mollie payment
  if (o.mollie_payment_id) {
    try {
      const payment = await checkMolliePayment(o.mollie_payment_id);
      if (payment && payment.status === 'paid') {
        const updated = markOrderPaid(o);
        return res.json({ status: 'paid', order: updated });
      }
      return res.json({ status: payment?.status || 'pending' });
    } catch(e) { return res.json({ status: 'pending' }); }
  }

  // Check SumUp checkout
  if (o.sumup_checkout_id) {
    try {
      const checkout = await checkSumupCheckout(o.sumup_checkout_id);
      if (checkout && checkout.status === 'PAID') {
        const updated = markOrderPaid(o);
        return res.json({ status: 'paid', order: updated });
      }
      return res.json({ status: (checkout?.status || 'pending').toLowerCase() });
    } catch(e) { return res.json({ status: 'pending' }); }
  }
  res.json({ status: o.status });
});

// SumUp webhook — called by SumUp when checkout status changes
app.post('/api/sumup/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const checkoutId = req.body.id || req.body.checkout_id || req.body.event_id;
    const ref = req.body.checkout_reference;
    let o = null;
    if (ref) o = db.prepare('SELECT * FROM orders WHERE id=?').get(ref);
    if (!o && checkoutId) o = db.prepare('SELECT * FROM orders WHERE sumup_checkout_id=?').get(checkoutId);
    if (!o || o.status === 'paid') return;
    const checkout = await checkSumupCheckout(o.sumup_checkout_id);
    if (checkout && checkout.status === 'PAID') markOrderPaid(o);
  } catch(e) { console.error('SumUp webhook fout:', e.message); }
});

// Mollie webhook — called by Mollie when payment status changes
app.post('/api/mollie/webhook', async (req, res) => {
  const { id: paymentId } = req.body;
  res.status(200).send('OK'); // Always respond 200 first
  if (!paymentId) return;
  try {
    const payment = await checkMolliePayment(paymentId);
    if (!payment) return;
    const o = db.prepare('SELECT * FROM orders WHERE mollie_payment_id=?').get(paymentId);
    if (!o || o.status === 'paid') return;
    if (payment.status === 'paid') markOrderPaid(o);
  } catch(e) { console.error('Mollie webhook fout:', e.message); }
});

// Update order status (bar dashboard)
app.patch('/api/orders/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['pending','paid','preparing','ready','collected','cancelled','archived'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(status, req.params.id);
  const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id));
  broadcast('order_updated', { order });
  // Send SMS when order is ready
  if (status === 'ready') notifyOrderReady(order);
  res.json(order);
});

// Registreer cash/kaart-betaling aan de bar (zonder status te wijzigen)
app.patch('/api/orders/:id/register-payment', requireAuth, (req, res) => {
  const { method } = req.body; // 'cash' of 'sumup'
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Bestelling niet gevonden' });
  db.prepare("UPDATE orders SET cash_paid=1, method=?, updated_at=datetime('now') WHERE id=?")
    .run(method === 'sumup' ? 'sumup' : 'cash', req.params.id);
  const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id));
  broadcast('order_updated', { order });
  res.json(order);
});

// ── Rekeningen (tabs) ────────────────────────────────────────────
// Automatisch een permanente "Personeel"-rekening ophalen of aanmaken
function getOrCreateStaffTab() {
  let tab = db.prepare("SELECT * FROM tabs WHERE is_staff=1 LIMIT 1").get();
  if (!tab) {
    const r = db.prepare("INSERT INTO tabs (name, status, is_staff) VALUES (?, 'open', 1)")
      .run('🧑‍🍳 Personeel');
    tab = db.prepare("SELECT * FROM tabs WHERE id=?").get(r.lastInsertRowid);
  }
  return tab;
}

app.post('/api/tabs', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Naam vereist' });
  const r = db.prepare("INSERT INTO tabs (name) VALUES (?)").run(name.trim());
  res.json(db.prepare('SELECT * FROM tabs WHERE id=?').get(r.lastInsertRowid));
});

function tabWithDetails(t) {
  const orders = db.prepare('SELECT * FROM orders WHERE tab_id=? AND status NOT IN (\'cancelled\')').all(t.id);
  const unpaid = orders.filter(o => !o.cash_paid);
  const total = orders.reduce((s,o)=>s+o.amount,0);
  const openAmount = unpaid.reduce((s,o)=>s+o.amount,0);
  // Items samenvoegen per product
  const items = {};
  orders.forEach(o => {
    db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id).forEach(i => {
      const k = i.name;
      if (!items[k]) items[k] = { name: i.name, icon: i.icon, qty: 0, total: 0, price: i.price };
      items[k].qty += i.qty; items[k].total += i.price * i.qty;
    });
  });
  return { ...t, order_count: orders.length, total, open_amount: openAmount, items: Object.values(items) };
}

app.get('/api/tabs', requireAuth, (req, res) => {
  const status = req.query.status || 'open';
  // Personeelsrekening niet meesturen in de gewone lijst — die heeft zijn eigen endpoint
  const tabs = db.prepare('SELECT * FROM tabs WHERE status=? AND is_staff=0 ORDER BY created_at DESC').all(status);
  res.json(tabs.map(tabWithDetails));
});

// Personeelsrekening apart ophalen (met totalen deze dag/week/all-time)
app.get('/api/tabs/staff', requireAuth, (req, res) => {
  const tab = getOrCreateStaffTab();
  const details = tabWithDetails(tab);
  const dayTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as v, COUNT(*) as n
    FROM orders WHERE tab_id=? AND status!='cancelled'
      AND DATE(created_at,'localtime')=DATE('now','localtime')
  `).get(tab.id);
  const weekTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as v, COUNT(*) as n
    FROM orders WHERE tab_id=? AND status!='cancelled'
      AND DATE(created_at,'localtime') >= DATE('now','localtime','-7 days')
  `).get(tab.id);
  res.json({ ...details, day_total: dayTotal.v, day_orders: dayTotal.n, week_total: weekTotal.v, week_orders: weekTotal.n });
});

// Rekening afsluiten: alle openstaande bestellingen op betaald
app.post('/api/tabs/:id/close', requireAuth, (req, res) => {
  const { method } = req.body; // 'cash' | 'sumup' | 'invoice'
  const t = db.prepare('SELECT * FROM tabs WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Rekening niet gevonden' });
  if (t.is_staff) return res.status(400).json({ error: 'De Personeel-rekening kan niet worden afgesloten' });
  const m = ['cash','sumup','invoice'].includes(method) ? method : 'cash';
  db.prepare("UPDATE orders SET cash_paid=1, method=?, updated_at=datetime('now') WHERE tab_id=? AND cash_paid=0").run(m, t.id);
  db.prepare("UPDATE tabs SET status='closed', closed_at=datetime('now') WHERE id=?").run(t.id);
  const orders = db.prepare('SELECT * FROM orders WHERE tab_id=?').all(t.id);
  orders.forEach(o => broadcast('order_updated', { order: hydrate(o) }));
  res.json({ ok: true, tab: tabWithDetails(db.prepare('SELECT * FROM tabs WHERE id=?').get(t.id)) });
});

// ── Verkochte items per dag ──────────────────────────────────────
app.get('/api/stats/items-sold', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const rows = db.prepare(`
    SELECT oi.name, oi.icon, SUM(oi.qty) as qty, SUM(oi.price*oi.qty) as revenue, p.category
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE DATE(o.created_at,'localtime') >= ? AND DATE(o.created_at,'localtime') <= ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
    GROUP BY oi.name, oi.icon, p.category
    ORDER BY qty DESC
  `).all(from, to);
  const totalItems = rows.reduce((s,r)=>s+r.qty,0);
  const totalRevenue = rows.reduce((s,r)=>s+r.revenue,0);
  res.json({ from, to, items: rows, total_items: totalItems, total_revenue: totalRevenue });
});

// ── Piekuren: drukte per uur ───────────────────────────────────
app.get('/api/stats/busy-hours', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  // Per uur (lokale tijd), enkel betaalde/afgehandelde klant-bestellingen
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', o.created_at, 'localtime') AS INTEGER) as hour,
      COUNT(DISTINCT o.id) as orders,
      SUM(oi.qty) as items,
      SUM(oi.price*oi.qty) as revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE DATE(o.created_at,'localtime') >= ? AND DATE(o.created_at,'localtime') <= ?
      AND o.status NOT IN ('cancelled','archived','pending')
      AND o.is_staff = 0
    GROUP BY hour
    ORDER BY hour
  `).all(from, to);
  // Vul alle 24 uren aan zodat de grafiek doorloopt
  const byHour = {};
  rows.forEach(r => byHour[r.hour] = r);
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const r = byHour[h];
    hours.push({ hour: h, orders: r?.orders||0, items: r?.items||0, revenue: r?.revenue||0 });
  }
  const totalOrders = rows.reduce((s,r)=>s+r.orders,0);
  const totalItems = rows.reduce((s,r)=>s+r.items,0);
  const totalRevenue = rows.reduce((s,r)=>s+r.revenue,0);
  const peakByItems = rows.length ? rows.reduce((a,b)=>a.items>b.items?a:b) : null;
  const peakByOrders = rows.length ? rows.reduce((a,b)=>a.orders>b.orders?a:b) : null;

  // Aantal actieve dagen (voor gemiddelde per uur per dag)
  const days = db.prepare(`
    SELECT COUNT(DISTINCT DATE(created_at,'localtime')) as n FROM orders
    WHERE DATE(created_at,'localtime') >= ? AND DATE(created_at,'localtime') <= ?
      AND status NOT IN ('cancelled','archived','pending') AND is_staff = 0
  `).get(from, to).n || 1;

  res.json({
    from, to, hours,
    total_orders: totalOrders, total_items: totalItems, total_revenue: totalRevenue,
    peak_items: peakByItems, peak_orders: peakByOrders,
    active_days: days,
  });
});

// Personeelsdrankjes: apart overzicht (uit de omzet gehouden)
app.get('/api/stats/staff-drinks', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const rows = db.prepare(`
    SELECT oi.name, oi.icon,
           SUM(oi.qty) as qty,
           SUM(oi.price*oi.qty) as value_lost,
           SUM(oi.qty*COALESCE(p.cost_price,0)) as cost,
           p.category
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE DATE(o.created_at,'localtime') >= ? AND DATE(o.created_at,'localtime') <= ?
      AND o.status != 'cancelled' AND o.is_staff = 1
    GROUP BY oi.name, oi.icon, p.category
    ORDER BY qty DESC
  `).all(from, to);
  const totalQty = rows.reduce((s,r)=>s+r.qty,0);
  const totalValue = rows.reduce((s,r)=>s+r.value_lost,0);
  const totalCost = rows.reduce((s,r)=>s+(r.cost||0),0);
  res.json({ from, to, items: rows, total_qty: totalQty, total_value: totalValue, total_cost: totalCost });
});

// ── Verborgen: cash-orders permanent uit systeem verwijderen ────
// (voor /zwartgeld pagina — geen restore, geen sporen behalve in stock_log)
app.get('/api/zwartgeld/list', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const orders = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) as item_count
    FROM orders o
    WHERE method='cash' AND DATE(created_at,'localtime') >= ? AND DATE(created_at,'localtime') <= ?
      AND status NOT IN ('cancelled')
    ORDER BY created_at DESC
  `).all(from, to);
  // Items er even bij zodat de pagina ze kan tonen
  const withItems = orders.map(o => ({
    ...o,
    items: db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id),
  }));
  const total = orders.reduce((s,o)=>s+o.amount,0);
  res.json({ from, to, orders: withItems, total });
});

app.post('/api/zwartgeld/purge', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Geen bestellingen geselecteerd' });
  const placeholders = ids.map(()=>'?').join(',');
  // Enkel cash-orders mogen zo geschrapt worden
  const orders = db.prepare(`SELECT id FROM orders WHERE id IN (${placeholders}) AND method='cash'`).all(...ids);
  const validIds = orders.map(o=>o.id);
  if (!validIds.length) return res.status(400).json({ error: 'Geen cash-bestellingen gevonden in selectie' });
  const ph2 = validIds.map(()=>'?').join(',');
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM order_items WHERE order_id IN (${ph2})`).run(...validIds);
    db.prepare(`DELETE FROM stock_log WHERE order_id IN (${ph2})`).run(...validIds);
    db.prepare(`DELETE FROM orders WHERE id IN (${ph2})`).run(...validIds);
  });
  tx();
  validIds.forEach(id => broadcast('order_deleted', { id }));
  res.json({ ok: true, deleted: validIds.length });
});

// ── Jobstudent-shiften ────────────────────────────────────────────
app.get('/api/staff/shifts', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const rows = db.prepare('SELECT * FROM staff_shifts WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC').all(from, to);
  const totalHours = rows.reduce((s,r)=>s+r.hours,0);
  const totalCost = rows.reduce((s,r)=>s+r.hours*r.hourly_rate,0);
  res.json({ from, to, shifts: rows, total_hours: totalHours, total_cost: totalCost });
});

app.post('/api/staff/shifts', requireAuth, (req, res) => {
  const { date, name, hours, hourly_rate, note } = req.body;
  if (!date || !name || !hours) return res.status(400).json({ error: 'Datum, naam en uren zijn verplicht' });
  const defaultRate = parseFloat(getSetting('staffHourlyRate') || '0');
  const rate = hourly_rate != null && hourly_rate !== '' ? parseFloat(hourly_rate) : defaultRate;
  const r = db.prepare('INSERT INTO staff_shifts (date,name,hours,hourly_rate,note) VALUES (?,?,?,?,?)')
    .run(date, name.trim(), parseFloat(hours), rate, (note||'').trim());
  res.json(db.prepare('SELECT * FROM staff_shifts WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/staff/shifts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM staff_shifts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Winst-overzicht (omzet – inkoop – lonen – overhead) ──────────
app.get('/api/stats/profit', requireAuth, (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const vatLiable = getSetting('vatLiable') !== 'false';   // default true
  const vatDefault = parseFloat(getSetting('jsVat') || '21');

  // Helper: bedrag omzetten naar "effectieve kost" op basis van btw-plicht
  // - btw-plichtig: excl-btw (btw is aftrekbaar, geen kost)
  // - niet btw-plichtig: incl-btw (btw is een echte kost)
  // Inputbedragen bij cost_price zijn per conventie excl. btw.
  const withVat = (excl, rate) => vatLiable ? excl : excl * (1 + (rate||vatDefault)/100);

  // Omzet: alles wat betaald is (excl. staff, cancelled, pending)
  const orderRows = db.prepare(`
    SELECT oi.qty, oi.price, oi.product_id, p.cost_price, p.vat_rate as prod_vat, o.gift
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE DATE(o.created_at,'localtime') >= ? AND DATE(o.created_at,'localtime') <= ?
      AND o.status NOT IN ('cancelled','archived','pending')
      AND o.is_staff = 0
  `).all(from, to);
  let revenue = 0, cogs = 0, itemsSold = 0;
  orderRows.forEach(r => {
    revenue += r.qty * r.price;
    cogs += r.qty * withVat(r.cost_price || 0, r.prod_vat);
    itemsSold += r.qty;
  });
  // Cadeaus (bijentip): toegevoegd op ordertotaal, tellen eenmalig
  const gifts = db.prepare(`
    SELECT COALESCE(SUM(gift),0) as g FROM orders
    WHERE DATE(created_at,'localtime') >= ? AND DATE(created_at,'localtime') <= ?
      AND status NOT IN ('cancelled','archived','pending') AND is_staff = 0
  `).get(from, to).g;
  revenue += gifts;

  // Personeelsdrankjes: enkel de aankoopkost (retail-waarde is niet betaald door de klant)
  const staffRows = db.prepare(`
    SELECT oi.qty, oi.price, p.cost_price, p.vat_rate as prod_vat
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE DATE(o.created_at,'localtime') >= ? AND DATE(o.created_at,'localtime') <= ?
      AND o.status != 'cancelled' AND o.is_staff = 1
  `).all(from, to);
  let staffCost = 0, staffQty = 0, staffRetail = 0;
  staffRows.forEach(r => {
    staffCost += r.qty * withVat(r.cost_price || 0, r.prod_vat);
    staffRetail += r.qty * r.price;
    staffQty += r.qty;
  });

  // Lonen — btw wordt toegepast a.d.h.v. de instelling
  const laborRow = db.prepare(`
    SELECT COALESCE(SUM(hours*hourly_rate),0) as cost, COALESCE(SUM(hours),0) as hours
    FROM staff_shifts WHERE date >= ? AND date <= ?
  `).get(from, to);
  const laborCostExcl = laborRow.cost;
  const laborCostIncl = laborCostExcl * (1 + vatDefault/100);
  const laborCost = vatLiable ? laborCostExcl : laborCostIncl;
  const laborHours = laborRow.hours;

  // Overige kosten — geprorateerd per open dag over de dekkingsperiode van elke boeking.
  // Bv. maandelijkse elektriciteit van €90: als de bar 13 opendagen heeft in die maand,
  // dan is dat €6,92 per opendag. Voor de shown periode nemen we het aantal opendagen
  // dat binnen de dekking valt.
  const openingDays = getOpeningDays();
  const openDaysInShown = countOpeningDays(from, to, openingDays);
  const overheadRows = db.prepare(`
    SELECT id, date, category, amount_incl, vat_rate, period FROM overhead_costs
  `).all();
  let overheadTotal = 0;
  const overheadByCategory = {};
  overheadRows.forEach(r => {
    const excl = r.amount_incl / (1 + (r.vat_rate||0)/100);
    const effective = vatLiable ? excl : r.amount_incl;
    const cov = overheadCoverage(r);
    const inter = intersect(cov.start, cov.end, from, to);
    if (!inter) return;
    const openInCoverage = countOpeningDays(cov.start, cov.end, openingDays);
    const openInIntersection = countOpeningDays(inter.start, inter.end, openingDays);
    if (openInCoverage === 0) return;   // geen open dagen in dekking → geen kost toewijsbaar
    const perOpenDay = effective / openInCoverage;
    const applied = perOpenDay * openInIntersection;
    overheadTotal += applied;
    overheadByCategory[r.category] = (overheadByCategory[r.category] || 0) + applied;
  });

  const grossMargin = revenue - cogs;
  const netProfit = grossMargin - staffCost - laborCost - overheadTotal;
  res.json({
    from, to,
    revenue, cogs, gross_margin: grossMargin,
    staff_cost: staffCost, staff_qty: staffQty, staff_retail: staffRetail,
    labor_cost: laborCost, labor_cost_excl: laborCostExcl, labor_cost_incl: laborCostIncl,
    labor_hours: laborHours,
    overhead_total: overheadTotal, overhead_by_category: overheadByCategory,
    opening_days_in_period: openDaysInShown, opening_days_setting: openingDays,
    vat_liable: vatLiable, vat_rate: vatDefault,
    net_profit: netProfit,
    items_sold: itemsSold, gifts,
  });
});

// ── Vrije factuur via Billit (bv. voor een rekening/groep) ──────
app.post('/api/billit/invoice-custom', requireAuth, async (req, res) => {
  const { customerName, customerVat, customerEmail, customerAddress, customerCity, customerZip, lines, tabId, orderId, send } = req.body;
  if (!customerName) return res.status(400).json({ error: 'Klantnaam vereist' });

  // Lijnen: uit een losse bestelling, uit een rekening (tab), of expliciet meegegeven
  let invoiceLines = lines;
  let sourceOrderId = null;

  if ((!invoiceLines || !invoiceLines.length) && orderId) {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) return res.status(404).json({ error: 'Bestelling niet gevonden' });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    if (!items.length) return res.status(400).json({ error: 'Bestelling heeft geen items' });
    invoiceLines = items.map(i => ({
      description: i.name, qty: i.qty, unit_price_incl: i.price,
    }));
    sourceOrderId = orderId;
  }
  if ((!invoiceLines || !invoiceLines.length) && tabId) {
    const t = db.prepare('SELECT * FROM tabs WHERE id=?').get(tabId);
    if (!t) return res.status(404).json({ error: 'Rekening niet gevonden' });
    invoiceLines = tabWithDetails(t).items.map(i => ({
      description: i.name, qty: i.qty, unit_price_incl: i.price,
    }));
  }
  if (!invoiceLines || !invoiceLines.length) return res.status(400).json({ error: 'Geen factuurregels' });

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  try {
    const orderLines = invoiceLines.map(l => {
      const vatR = l.vat_rate != null ? parseFloat(l.vat_rate) : vatDrinks;
      const incl = parseFloat(l.unit_price_incl);
      const excl = incl / (1 + vatR/100);
      return {
        Quantity: parseInt(l.qty) || 1,
        UnitPriceExcl: parseFloat(excl.toFixed(4)),
        Description: l.description,
        VATPercentage: vatR,
      };
    });
    // Straat en huisnummer splitsen (Billit verwacht Street + StreetNumber apart)
    const addrRaw = (customerAddress || '').trim();
    const addrMatch = addrRaw.match(/^(.*?)[\s,]+(\d+[a-zA-Z]?(?:\s*(?:bus|b)\s*\w+)?)$/);
    const street = addrMatch ? addrMatch[1].trim() : addrRaw;
    const streetNumber = addrMatch ? addrMatch[2].trim() : '';

    const today = new Date();
    const expiry = new Date(today.getTime() + 14*24*3600*1000); // 14 dagen betaaltermijn

    // Customer volgens Billit Party-model: Email/PartyType rechtstreeks op het object
    const customer = {
      Name: customerName,
      PartyType: 'Customer',
      Language: 'NL',
      Addresses: [{
        AddressType: 'InvoiceAddress',
        Name: customerName,
        Street: street,
        StreetNumber: streetNumber,
        City: customerCity || '',
        Zipcode: customerZip || '',
        CountryCode: 'BE',
      }],
    };
    if (customerVat) customer.VATNumber = customerVat.replace(/[\s.]/g, '');
    if (customerEmail) customer.Email = customerEmail;

    const payload = {
      OrderType: 'Invoice',
      OrderDirection: 'Income',
      OrderDate: today.toISOString().slice(0,10),
      ExpiryDate: expiry.toISOString().slice(0,10),
      Currency: 'EUR',
      Customer: customer,
      OrderLines: orderLines,
    };
    const created = await billitRequest('POST', '/v1/orders', payload);
    const billitOrderId = created?.OrderID || created;

    // Optioneel meteen verzenden via Billit (e-mail)
    let sent = false;
    if (send && customerEmail && billitOrderId) {
      try {
        await billitRequest('POST', '/v1/orders/commands/send', {
          Transporttype: 'SMTP',
          OrderIDs: [billitOrderId],
        });
        sent = true;
      } catch(e) { /* factuur bestaat, verzenden faalde */ }
    }
    // Rekening afsluiten indien vanuit tab
    if (tabId) {
      db.prepare("UPDATE orders SET cash_paid=1, method='invoice', updated_at=datetime('now') WHERE tab_id=? AND cash_paid=0").run(tabId);
      db.prepare("UPDATE tabs SET status='closed', closed_at=datetime('now') WHERE id=?").run(tabId);
    }
    // Bestelling markeren als gefactureerd
    if (sourceOrderId) {
      db.prepare("UPDATE orders SET invoice_billit_id=?, invoice_customer_name=?, updated_at=datetime('now') WHERE id=?")
        .run(String(billitOrderId), customerName, sourceOrderId);
    }
    res.json({ ok: true, billit_order_id: billitOrderId, sent });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Data resetten (voor live gaan) ───────────────────────────────
// Verwijdert alle bestellingen, verkopen en boekhoud-data.
// Producten en instellingen blijven behouden. Vereist bevestiging.
app.post('/api/reset', requireAuth, (req, res) => {
  const { confirm, keepStock } = req.body;
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Bevestiging vereist' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM stock_log').run();
    db.prepare('DELETE FROM sumup_sales').run();
    db.prepare('DELETE FROM tabs').run();
    // Verwijder dagontvangsten/factuur-referenties uit settings
    const keys = db.prepare("SELECT key FROM settings WHERE key LIKE 'daily_receipt_%' OR key LIKE 'invoice_%'").all();
    const delSetting = db.prepare('DELETE FROM settings WHERE key=?');
    keys.forEach(k => delSetting.run(k.key));
    // Reset bestelnummer-teller
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('orderCounter','0')").run();
  });
  tx();

  orderNumCounter = 1; // reset in-memory teller
  broadcast('orders_reset', {});
  res.json({ ok: true, message: 'Alle bestellingen en boekhoud-data gewist' });
});

app.delete('/api/orders/:id', requireAuth, (req, res) => {
  db.prepare("UPDATE orders SET status='archived' WHERE id=?").run(req.params.id);
  broadcast('order_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Bestelling volledig annuleren: voorraad terugzetten + uit alle statistieken
app.post('/api/orders/:id/cancel', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Bestelling niet gevonden' });
  if (o.status === 'cancelled') return res.json({ ok: true, already: true });

  // Voorraad terugzetten als die eerder was afgetrokken
  // (cash/tab: bij aanmaak; online: bij betaling → dus alles behalve 'pending')
  const stockWasDeducted = o.status !== 'pending';
  if (stockWasDeducted) {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
    const restore = db.prepare('UPDATE products SET stock = stock + ? WHERE id=? AND stock >= 0');
    const logStock = db.prepare("INSERT INTO stock_log (product_id,delta,reason,order_id) VALUES (?,?,'cancel_restore',?)");
    items.forEach(i => {
      if (i.product_id) { restore.run(i.qty, i.product_id); logStock.run(i.product_id, i.qty, o.id); }
    });
  }
  db.prepare("UPDATE orders SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(o.id);
  broadcast('order_deleted', { id: o.id });
  broadcast('products_updated', {});
  res.json({ ok: true, stock_restored: stockWasDeducted });
});

// Historiek staat hierboven geregistreerd (vóór /api/orders/:id)

// Stats
app.get('/api/stats', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const stats = db.prepare(`
    SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as revenue,
      COUNT(CASE WHEN method='cash' THEN 1 END) as cash_count,
      COALESCE(SUM(CASE WHEN method='cash' THEN amount END),0) as cash_revenue,
      COUNT(CASE WHEN method='sumup' THEN 1 END) as card_count,
      COALESCE(SUM(CASE WHEN method='sumup' THEN amount END),0) as card_revenue
    FROM orders WHERE DATE(created_at,'localtime')=? AND status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).get(today);
  const topProducts = db.prepare(`
    SELECT oi.name,oi.icon,SUM(oi.qty) as sold,SUM(oi.qty*oi.price) as revenue
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE DATE(o.created_at,'localtime')=? AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
    GROUP BY oi.name ORDER BY sold DESC LIMIT 8
  `).all(today);
  const lowStock = db.prepare('SELECT * FROM products WHERE stock>=0 AND stock<=low_stock AND active=1').all();
  res.json({ ...stats, top_products: topProducts, low_stock: lowStock });
});

// Publieke versie-info (voor headers in de UI)
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// ── Overige kosten (elektriciteit, afval, administratie …) ─────

// Openingsdagen als CSV van dag-nummers (0=zo, 1=ma, …, 6=za) — standaard vr/za/zo
function getOpeningDays() {
  const raw = getSetting('openingDays') || '5,6,0';
  return raw.split(',').map(s => parseInt(s.trim())).filter(n => n>=0 && n<=6);
}

function countOpeningDays(fromStr, toStr, openingDays) {
  const set = new Set(openingDays);
  let count = 0;
  const d = new Date(fromStr + 'T00:00:00');
  const end = new Date(toStr + 'T00:00:00');
  while (d <= end) {
    if (set.has(d.getDay())) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// Bepaal de dekkingsperiode van een overhead-record op basis van zijn periode-type
function overheadCoverage(record) {
  const d = new Date(record.date + 'T00:00:00');
  const period = record.period || 'maand';
  const y = d.getFullYear();
  const m = d.getMonth();
  const iso = dd => dd.toISOString().slice(0,10);
  switch (period) {
    case 'dag':      return { start: record.date, end: record.date };
    case 'week': {
      const dow = d.getDay();
      const diff = dow === 0 ? -6 : 1 - dow;   // maandag = 1
      const mon = new Date(d); mon.setDate(d.getDate() + diff);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { start: iso(mon), end: iso(sun) };
    }
    case 'maand':    return { start: iso(new Date(y, m, 1)),   end: iso(new Date(y, m+1, 0)) };
    case 'kwartaal': {
      const q = Math.floor(m/3);
      return { start: iso(new Date(y, q*3, 1)), end: iso(new Date(y, q*3+3, 0)) };
    }
    case 'jaar':     return { start: iso(new Date(y, 0, 1)),   end: iso(new Date(y, 11, 31)) };
    default:         return { start: record.date, end: record.date };
  }
}

// Snijding van twee periodes (yyyy-mm-dd strings). Geeft null als geen overlap.
function intersect(aStart, aEnd, bStart, bEnd) {
  const start = aStart > bStart ? aStart : bStart;
  const end   = aEnd   < bEnd   ? aEnd   : bEnd;
  if (start > end) return null;
  return { start, end };
}

app.get('/api/overhead-costs', requireAuth, (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2999-12-31';
  const vatLiable = getSetting('vatLiable') !== 'false';
  const rows = db.prepare(`
    SELECT * FROM overhead_costs
    WHERE date >= ? AND date <= ?
    ORDER BY date DESC, id DESC
  `).all(from, to);
  const totalIncl = rows.reduce((s,r)=>s+r.amount_incl,0);
  const totalExcl = rows.reduce((s,r)=>s + r.amount_incl / (1 + (r.vat_rate||0)/100), 0);
  const totalEffective = vatLiable ? totalExcl : totalIncl;
  res.json({ from, to, costs: rows, total_incl: totalIncl, total_excl: totalExcl, total_effective: totalEffective, vat_liable: vatLiable });
});

app.post('/api/overhead-costs', requireAuth, (req, res) => {
  const { date, category, description, amount_incl, vat_rate, period } = req.body;
  if (!date || !category || amount_incl == null) return res.status(400).json({ error: 'Datum, categorie en bedrag zijn verplicht' });
  const validPeriods = ['dag','week','maand','kwartaal','jaar'];
  const p = validPeriods.includes(period) ? period : 'maand';
  const r = db.prepare('INSERT INTO overhead_costs (date, category, description, amount_incl, vat_rate, period) VALUES (?,?,?,?,?,?)')
    .run(date, category, description || '', parseFloat(amount_incl), vat_rate != null ? parseFloat(vat_rate) : 21, p);
  res.json(db.prepare('SELECT * FROM overhead_costs WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/overhead-costs/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM overhead_costs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Dagkasboek ─────────────────────────────────────────────────
// Alle cash-transacties per dag, met startbedrag, cash uitgaven en Billit-samenvatting.
// Respecteert het zwartgeld-principe: bestellingen die via /zwartgeld gewist zijn,
// verschijnen automatisch niet meer (ze zitten niet meer in de database).
app.get('/api/cashbook/day', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const vatLiable = getSetting('vatLiable') !== 'false';

  // Cash bestellingen (klant en rekening-afsluiting via cash): enkel echt betaalde
  const orders = db.prepare(`
    SELECT o.id, o.order_number, o.created_at, o.amount, o.note, o.cash_paid, o.tab_id, t.name AS tab_name
    FROM orders o LEFT JOIN tabs t ON t.id = o.tab_id
    WHERE DATE(o.created_at,'localtime') = ?
      AND o.method = 'cash'
      AND o.status NOT IN ('cancelled','pending','archived')
      AND o.is_staff = 0
      AND o.cash_paid = 1
    ORDER BY o.created_at
  `).all(date);

  const ordersTotal = orders.reduce((s,o)=>s+o.amount,0);

  // Handmatige entries: startbedrag, extra inkomsten, uitgaven
  const entries = db.prepare(`
    SELECT * FROM cash_journal_entries WHERE date=? ORDER BY type, id
  `).all(date);
  const startEntry = entries.find(e => e.type === 'start');
  const startAmount = startEntry ? startEntry.amount : 0;
  const incomes = entries.filter(e => e.type === 'income');
  const expenses = entries.filter(e => e.type === 'expense');
  const incomeTotal = incomes.reduce((s,e)=>s+e.amount,0);
  const expenseTotal = expenses.reduce((s,e)=>s+e.amount,0);

  const totalIn = ordersTotal + incomeTotal;
  const endBalance = startAmount + totalIn - expenseTotal;

  // Billit-samenvatting: dagontvangsten per btw-tarief (op basis van producten)
  // Enkel op basis van cash-bestellingen (het is een cash-boek).
  const vatSplitRows = db.prepare(`
    SELECT COALESCE(p.vat_rate, 6) AS rate, SUM(oi.qty*oi.price) AS gross
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE DATE(o.created_at,'localtime') = ?
      AND o.method = 'cash'
      AND o.status NOT IN ('cancelled','pending','archived')
      AND o.is_staff = 0
      AND o.cash_paid = 1
    GROUP BY rate
    ORDER BY rate
  `).all(date);
  const vatSplit = vatSplitRows.map(r => {
    const rate = r.rate || 0;
    const gross = r.gross || 0;
    const excl = rate > 0 ? gross / (1 + rate/100) : gross;
    const vat = gross - excl;
    return { rate, gross, excl, vat };
  });

  res.json({
    date,
    start_amount: startAmount,
    start_entry_id: startEntry ? startEntry.id : null,
    orders, orders_total: ordersTotal,
    incomes, income_total: incomeTotal,
    expenses, expense_total: expenseTotal,
    total_in: totalIn,
    end_balance: endBalance,
    vat_liable: vatLiable,
    vat_split: vatSplit,
  });
});

app.post('/api/cashbook/entry', requireAuth, (req, res) => {
  const { date, type, description, amount } = req.body;
  if (!date || !type || amount == null) return res.status(400).json({ error: 'Datum, type en bedrag zijn verplicht' });
  if (!['start','expense','income'].includes(type)) return res.status(400).json({ error: 'Ongeldig type' });
  const amt = parseFloat(amount);
  if (isNaN(amt)) return res.status(400).json({ error: 'Ongeldig bedrag' });
  // Startbedrag: overschrijf bestaande dagstart
  if (type === 'start') {
    const existing = db.prepare("SELECT id FROM cash_journal_entries WHERE date=? AND type='start'").get(date);
    if (existing) {
      db.prepare('UPDATE cash_journal_entries SET amount=?, description=? WHERE id=?')
        .run(amt, description||'', existing.id);
      res.json(db.prepare('SELECT * FROM cash_journal_entries WHERE id=?').get(existing.id));
      return;
    }
  }
  const r = db.prepare('INSERT INTO cash_journal_entries (date,type,description,amount) VALUES (?,?,?,?)')
    .run(date, type, description||'', amt);
  res.json(db.prepare('SELECT * FROM cash_journal_entries WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/cashbook/entry/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cash_journal_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Settings — admin only (contains secrets)
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const r = {};
  rows.forEach(row => { try { r[row.key] = JSON.parse(row.value); } catch { r[row.key] = row.value; } });
  delete r.adminPasswordHash; // never expose
  res.json(r);
});

// Public settings — only safe fields for the customer ordering page
app.get('/api/settings/public', (req, res) => {
  res.json({
    barName: getSetting('barName') || 'Zomerbar',
    payProvider: getSetting('payProvider') || 'mollie',
    hasMollie: !!getSetting('mollieKey'),
    hasSumup: !!getSetting('sumupApiKey'),
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  Object.entries(req.body).forEach(([k,v]) => {
    if (k === 'adminPasswordHash') return; // protect
    upsert.run(k, JSON.stringify(v));
  });
  res.json({ ok: true });
});

// Test SMS via Twilio
app.post('/api/sms/test', requireAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Gsm-nummer verplicht' });
  const client = getTwilioClient();
  if (!client) return res.status(400).json({ error: 'Geen Twilio-sleutels ingesteld. Vul Account SID, Auth Token en afzendernummer in via Beheer → SMS.' });
  try {
    const result = await sendSMS(phone, `${getSetting('barName')||'Zomerbar'}: Test SMS — alles werkt! ☀️`);
    res.json({ ok: true, sid: result.sid });
  } catch(e) {
    res.status(400).json({ error: e.message || 'SMS mislukt' });
  }
});

// Stock log
app.get('/api/stock/log', requireAuth, (req, res) => {
  const log = db.prepare(`
    SELECT sl.*, p.name, p.icon FROM stock_log sl
    LEFT JOIN products p ON p.id=sl.product_id
    ORDER BY sl.created_at DESC LIMIT 100
  `).all();
  res.json(log);
});

// ── Kasdagboek (cash book) ───────────────────────────────────────
// Returns paid orders grouped by day, with VAT breakdown
app.get('/api/cashbook', requireAuth, (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || new Date().toISOString().slice(0,10);
  const dateTo = to || dateFrom;

  const orders = db.prepare(`
    SELECT o.*, DATE(o.created_at,'localtime') as day FROM orders o
    WHERE DATE(o.created_at,'localtime') BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
    ORDER BY o.created_at ASC
  `).all(dateFrom, dateTo);

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');

  // Group by day
  const days = {};
  orders.forEach(o => {
    if (!days[o.day]) days[o.day] = { date: o.day, orders: [], cash: 0, card: 0, total: 0, gift: 0, vat: {} };
    const d = days[o.day];
    const items = db.prepare('SELECT oi.*, p.vat_type FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    d.orders.push({ ...o, items });
    if (o.method === 'cash') d.cash += o.amount;
    else d.card += o.amount;
    d.total += o.amount;
    if (o.gift > 0) d.gift += o.gift;
    // VAT breakdown per line
    items.forEach(it => {
      const rate = it.vat_type === 'food' ? vatFood : vatDrinks;
      const lineTotal = it.price * it.qty; // incl VAT
      const excl = lineTotal / (1 + rate/100);
      const vat = lineTotal - excl;
      if (!d.vat[rate]) d.vat[rate] = { rate, incl: 0, excl: 0, vat: 0 };
      d.vat[rate].incl += lineTotal;
      d.vat[rate].excl += excl;
      d.vat[rate].vat += vat;
    });
  });

  // Totals across the period
  const totals = { cash: 0, card: 0, total: 0, gift: 0, vat: {}, order_count: orders.length };
  Object.values(days).forEach(d => {
    totals.cash += d.cash; totals.card += d.card; totals.total += d.total; totals.gift += d.gift;
    Object.values(d.vat).forEach(v => {
      if (!totals.vat[v.rate]) totals.vat[v.rate] = { rate: v.rate, incl: 0, excl: 0, vat: 0 };
      totals.vat[v.rate].incl += v.incl;
      totals.vat[v.rate].excl += v.excl;
      totals.vat[v.rate].vat += v.vat;
    });
  });

  res.json({
    from: dateFrom, to: dateTo,
    days: Object.values(days).map(d => ({ ...d, vat: Object.values(d.vat) })),
    totals: { ...totals, vat: Object.values(totals.vat) },
  });
});

// ── Maandfactuur naar Billit ─────────────────────────────────────
async function billitRequest(method, apiPath, body) {
  const env = getSetting('billitEnv') || 'sandbox';
  const apiKey = getSetting('billitApiKey');
  const partyId = getSetting('billitPartyId');
  if (!apiKey) throw new Error('Geen Billit API-sleutel ingesteld');
  if (!partyId) throw new Error('Geen Billit PartyID ingesteld (nodig zodat de factuur in jouw bedrijf terechtkomt)');
  const base = env === 'production' ? 'https://api.billit.be' : 'https://api.sandbox.billit.be';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'apiKey': apiKey,
    'partyID': String(partyId),
  };
  const r = await fetch(base + apiPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    console.error('Billit error', r.status, apiPath, '→', text.slice(0, 400));
    const msg = (data && data.errors) ? JSON.stringify(data.errors)
              : (data && data.Description) ? data.Description
              : (typeof data === 'string' && data) ? data
              : ('Billit fout ' + r.status);
    throw new Error(msg);
  }
  return data;
}

// Billit-verbinding testen: haalt bedrijfsinfo op zodat de gebruiker
// meteen ziet in welke Billit-account de facturen zullen landen.
app.get('/api/billit/test', requireAuth, async (req, res) => {
  const env = getSetting('billitEnv') || 'sandbox';
  const partyId = getSetting('billitPartyId');
  try {
    // /v1/parties/me → info over de aangesloten party
    let company_name = null;
    try {
      const me = await billitRequest('GET', '/v1/parties/me');
      company_name = me?.Name || me?.CommercialName || null;
    } catch(_) {
      // Fallback: gewoon een lege lijst opvragen om te verifiëren dat auth werkt
      await billitRequest('GET', '/v1/orders?$top=1');
    }
    res.json({ ok: true, env, party_id: partyId, company_name });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message, env, party_id: partyId });
  }
});

// ── Dagontvangsten naar Billit ───────────────────────────────────
// Stuurt de ontvangsten van één dag als een DailyRevenue document naar Billit
// ── Dagontvangsten overzicht (Billit-categorieën) ────────────────
// Toont per dag de ontvangsten gegroepeerd in Billit's BTW-categorieën
// zodat de barhouder ze manueel in Billit kan overtikken. Geen API-sync.
app.get('/api/billit/daily-overview', requireAuth, (req, res) => {
  const day = req.query.date || new Date().toISOString().slice(0,10);
  const orders = db.prepare(`
    SELECT o.id, o.amount, o.method, o.gift FROM orders o
    WHERE DATE(o.created_at,'localtime') = ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).all(day);

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');

  // Billit categories: 0, 6, 12, 21, and "zonder btw" (-1)
  const cats = { '0': 0, '6': 0, '12': 0, '21': 0, 'geen': 0 };
  let cash = 0, card = 0, giftTotal = 0;

  orders.forEach(o => {
    if (o.method === 'cash') cash += o.amount; else card += o.amount;
    if (o.gift > 0) { giftTotal += o.gift; cats['geen'] += o.gift; }
    const items = db.prepare('SELECT oi.*, p.vat_type, p.vat_rate FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    items.forEach(it => {
      const lineTotal = it.price * it.qty;
      let rate;
      if (it.vat_rate === -1) { cats['geen'] += lineTotal; return; }
      rate = it.vat_rate != null && it.vat_rate >= 0 ? it.vat_rate : (it.vat_type === 'food' ? vatFood : vatDrinks);
      const key = String(Math.round(rate));
      if (cats[key] != null) cats[key] += lineTotal;
      else cats['6'] += lineTotal; // fallback
    });
  });

  res.json({
    date: day,
    order_count: orders.length,
    cash, card, total: cash + card,
    gift: giftTotal,
    categories: cats, // incl. BTW bedragen per categorie
  });
});

app.post('/api/billit/daily-receipt', requireAuth, async (req, res) => {
  const { date } = req.body; // YYYY-MM-DD
  const day = date || new Date().toISOString().slice(0,10);

  const orders = db.prepare(`
    SELECT o.id, o.amount, o.method FROM orders o
    WHERE DATE(o.created_at,'localtime') = ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).all(day);

  if (!orders.length) return res.status(400).json({ error: 'Geen ontvangsten op deze dag' });

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');

  // Aggregate incl-amounts per VAT rate, split by payment method
  const byVat = {};
  let cash = 0, card = 0;
  orders.forEach(o => {
    if (o.method === 'cash') cash += o.amount; else card += o.amount;
    const items = db.prepare('SELECT oi.*, p.vat_type, p.vat_rate FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    items.forEach(it => {
      const rate = it.vat_rate != null && it.vat_rate > 0 ? it.vat_rate : (it.vat_type === 'food' ? vatFood : vatDrinks);
      const lineTotal = it.price * it.qty;
      if (!byVat[rate]) byVat[rate] = 0;
      byVat[rate] += lineTotal;
    });
  });

  // Build order lines per VAT rate (excl amounts — Billit calculates VAT)
  const orderLines = Object.entries(byVat).map(([rate, incl]) => {
    const r = parseFloat(rate);
    const excl = incl / (1 + r/100);
    return {
      Quantity: 1,
      UnitPriceExcl: parseFloat(excl.toFixed(2)),
      Description: `Dagontvangsten ${day} — ${r}% BTW`,
      VATPercentage: r,
    };
  });

  const total = Object.values(byVat).reduce((a,b)=>a+b,0);
  const barName = getSetting('barName') || 'Zomerbar';
  const barVat = getSetting('barVat') || '';
  const docNumber = `ZB-DR-${day.replace(/-/g,'')}`;

  // Dagontvangsten als Invoice met OrderDirection Income, vaste klant, automatisch betaald
  const body = {
    OrderType: 'Invoice',
    OrderDirection: 'Income',
    OrderNumber: docNumber,
    OrderDate: day,
    ExpiryDate: day,
    Currency: 'EUR',
    OrderTitle: `Dagontvangsten ${barName} ${day}`,
    Customer: {
      Name: 'Dagontvangsten',
      PartyType: 'Customer',
      Addresses: [{
        AddressType: 'InvoiceAddress',
        Name: 'Dagontvangsten',
        Street: 'Diverse klanten',
        City: 'Aan de bar',
        CountryCode: 'BE',
      }],
    },
    OrderLines: orderLines,
    Paid: true,
    PaidDate: day,
  };

  try {
    const result = await billitRequest('POST', '/v1/orders', body);
    const orderId = result.OrderID || result.orderID || result;
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run(`daily_receipt_${day}`, JSON.stringify({ orderId, createdAt: new Date().toISOString(), total, cash, card }));
    res.json({ ok: true, orderId, docNumber, total, cash, card, lines: orderLines });
  } catch(e) {
    res.status(400).json({ error: e.message, lines: orderLines });
  }
});

// Preview daily receipt without sending
app.get('/api/billit/daily-receipt/preview', requireAuth, (req, res) => {
  const day = req.query.date || new Date().toISOString().slice(0,10);
  const orders = db.prepare(`
    SELECT o.id, o.amount, o.method FROM orders o
    WHERE DATE(o.created_at,'localtime') = ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).all(day);

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');
  const byVat = {};
  let cash = 0, card = 0;
  orders.forEach(o => {
    if (o.method === 'cash') cash += o.amount; else card += o.amount;
    const items = db.prepare('SELECT oi.*, p.vat_type, p.vat_rate FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    items.forEach(it => {
      const rate = it.vat_rate != null && it.vat_rate > 0 ? it.vat_rate : (it.vat_type === 'food' ? vatFood : vatDrinks);
      const lineTotal = it.price * it.qty;
      if (!byVat[rate]) byVat[rate] = { rate, incl: 0, excl: 0, vat: 0 };
      byVat[rate].incl += lineTotal;
    });
  });
  Object.values(byVat).forEach(v => { v.excl = v.incl/(1+v.rate/100); v.vat = v.incl - v.excl; });

  const existing = getSetting(`daily_receipt_${day}`);
  res.json({
    date: day,
    order_count: orders.length,
    cash, card, total: cash + card,
    vat: Object.values(byVat),
    already_sent: existing || null,
  });
});

app.post('/api/invoice/monthly', requireAuth, async (req, res) => {
  const { year, month } = req.body; // month: 1-12
  if (!year || !month) return res.status(400).json({ error: 'Jaar en maand verplicht' });
  const mm = String(month).padStart(2, '0');
  const dateFrom = `${year}-${mm}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const dateTo = `${year}-${mm}-${String(lastDay).padStart(2,'0')}`;

  // Gather paid orders for the month
  const orders = db.prepare(`
    SELECT o.id, o.amount, o.method FROM orders o
    WHERE DATE(o.created_at,'localtime') BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).all(dateFrom, dateTo);

  if (!orders.length) return res.status(400).json({ error: 'Geen ontvangsten in deze maand' });

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');

  // Aggregate per VAT rate (amounts incl VAT)
  const byVat = {};
  orders.forEach(o => {
    const items = db.prepare('SELECT oi.*, p.vat_type FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    items.forEach(it => {
      const rate = it.vat_type === 'food' ? vatFood : vatDrinks;
      const lineTotal = it.price * it.qty;
      if (!byVat[rate]) byVat[rate] = 0;
      byVat[rate] += lineTotal;
    });
  });

  // Build OrderLines per VAT rate — convert incl to excl (Billit calculates VAT from UnitPriceExcl)
  const monthNames = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const orderLines = Object.entries(byVat).map(([rate, incl]) => {
    const r = parseFloat(rate);
    const excl = incl / (1 + r/100);
    return {
      Quantity: 1,
      UnitPriceExcl: parseFloat(excl.toFixed(2)),
      Description: `Dagontvangsten ${monthNames[month-1]} ${year} — ${r}% BTW`,
      VATPercentage: r,
    };
  });

  const barName = getSetting('barName') || 'Zomerbar';
  const barVat = getSetting('barVat') || '';
  const orderNumber = `ZB-${year}${mm}`;

  const invoiceBody = {
    OrderType: 'Invoice',
    OrderDirection: 'Income',
    OrderNumber: orderNumber,
    OrderDate: dateTo,
    ExpiryDate: dateTo,
    Currency: 'EUR',
    OrderTitle: `Maandelijkse dagontvangsten ${monthNames[month-1]} ${year}`,
    Customer: {
      Name: 'Dagontvangsten',
      PartyType: 'Customer',
      Addresses: [{
        AddressType: 'InvoiceAddress',
        Name: 'Dagontvangsten',
        Street: 'Diverse klanten',
        City: 'Aan de bar',
        CountryCode: 'BE',
      }],
    },
    OrderLines: orderLines,
    Paid: true,
  };

  try {
    const result = await billitRequest('POST', '/v1/orders', invoiceBody);
    const orderId = result.OrderID || result.orderID || result;
    // Save reference
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run(`invoice_${year}_${mm}`, JSON.stringify({ orderId, createdAt: new Date().toISOString(), amount: Object.values(byVat).reduce((a,b)=>a+b,0) }));
    res.json({ ok: true, orderId, orderNumber, lines: orderLines, vatBreakdown: byVat });
  } catch(e) {
    res.status(400).json({ error: e.message, lines: orderLines, vatBreakdown: byVat });
  }
});

// Preview monthly invoice without sending to Billit
app.get('/api/invoice/preview', requireAuth, (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Jaar en maand verplicht' });
  const mm = String(month).padStart(2, '0');
  const dateFrom = `${year}-${mm}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const dateTo = `${year}-${mm}-${String(lastDay).padStart(2,'0')}`;

  const orders = db.prepare(`
    SELECT o.id, o.amount, o.method FROM orders o
    WHERE DATE(o.created_at,'localtime') BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending') AND o.is_staff = 0
  `).all(dateFrom, dateTo);

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');
  const byVat = {};
  let cash = 0, card = 0;
  orders.forEach(o => {
    if (o.method === 'cash') cash += o.amount; else card += o.amount;
    const items = db.prepare('SELECT oi.*, p.vat_type FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    items.forEach(it => {
      const rate = it.vat_type === 'food' ? vatFood : vatDrinks;
      const lineTotal = it.price * it.qty;
      if (!byVat[rate]) byVat[rate] = { rate, incl: 0, excl: 0, vat: 0 };
      byVat[rate].incl += lineTotal;
    });
  });
  Object.values(byVat).forEach(v => {
    v.excl = v.incl / (1 + v.rate/100);
    v.vat = v.incl - v.excl;
  });

  const existing = getSetting(`invoice_${year}_${mm}`);
  res.json({
    year: parseInt(year), month: parseInt(month),
    order_count: orders.length,
    cash, card, total: cash + card,
    vat: Object.values(byVat),
    already_created: existing || null,
  });
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Page routing ─────────────────────────────────────────────────
const sendPage = (res, name) => res.sendFile(path.join(__dirname, 'public', name));

// Landingspagina = klant bestelpagina
app.get('/', (req, res) => sendPage(res, 'bestel.html'));
app.get('/bestel', (req, res) => sendPage(res, 'bestel.html'));

// Bar-sectie (personeel) achter /bar
app.get('/bar', (req, res) => sendPage(res, 'bar.html'));
app.get('/bar/start', (req, res) => sendPage(res, 'index.html'));
app.get('/bar/beheer', (req, res) => sendPage(res, 'beheer.html'));
app.get('/bar/boekhouding', (req, res) => sendPage(res, 'boekhouding.html'));
app.get('/bar/login', (req, res) => sendPage(res, 'login.html'));
app.get('/zwartgeld', (req, res) => sendPage(res, 'zwartgeld.html'));

// Oude directe paden → redirect naar /bar-versie (backwards compat)
app.get('/beheer', (req, res) => res.redirect('/bar/beheer'));
app.get('/boekhouding', (req, res) => res.redirect('/bar/boekhouding'));
app.get('/login', (req, res) => res.redirect('/bar/login'));

// SPA fallback — alles wat niet bestaat → bestelpagina
app.get('*', (req, res) => {
  const file = req.path.slice(1) + '.html';
  const full = path.join(__dirname, 'public', file);
  if (fs.existsSync(full)) return res.sendFile(full);
  res.sendFile(path.join(__dirname, 'public', 'bestel.html'));
});

// ── Achtergrond-poller voor online betalingen ────────────────────
// Controleert elke 20s alle wachtende Mollie/SumUp bestellingen.
// Zo wordt een betaling altijd geregistreerd, ook als de webhook faalt
// of de klant zijn pagina sluit.
function markOrderPaid(o) {
  db.prepare("UPDATE orders SET status='paid', updated_at=datetime('now') WHERE id=?").run(o.id);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  deductStock(items, o.id);
  const updated = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
  broadcast('order_updated', { order: updated });
  console.log(`💰 Betaling geregistreerd: bestelling #${o.order_number} (${o.id})`);
  return updated;
}

async function pollPendingPayments() {
  // Alleen recente wachtende online bestellingen (laatste 24u)
  const pending = db.prepare(`
    SELECT * FROM orders
    WHERE status='pending'
      AND (mollie_payment_id IS NOT NULL OR sumup_checkout_id IS NOT NULL)
      AND created_at > datetime('now','-1 day')
  `).all();
  for (const o of pending) {
    try {
      if (o.mollie_payment_id) {
        const payment = await checkMolliePayment(o.mollie_payment_id);
        if (payment && payment.status === 'paid') markOrderPaid(o);
        else if (payment && ['expired','canceled','failed'].includes(payment.status)) {
          // laat bestelling staan maar log
        }
      } else if (o.sumup_checkout_id) {
        const checkout = await checkSumupCheckout(o.sumup_checkout_id);
        if (checkout && checkout.status === 'PAID') markOrderPaid(o);
      }
    } catch(e) { /* stil, probeer volgende ronde opnieuw */ }
  }
}

// Start poller (elke 20 seconden)
setInterval(() => { pollPendingPayments().catch(()=>{}); }, 20000);

server.listen(PORT, () => console.log(`☀️  Zomerbar v5.4.0 op http://localhost:${PORT}`));
