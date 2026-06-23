const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');
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
`);

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
app.use(express.static(path.join(__dirname, 'public')));

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
  const from = getSetting('twilioFrom') || getSetting('smsOriginator') || 'Zomerbar';
  const to   = normalizePhone(phone);
  const msg  = await client.messages.create({ body: message, from, to });
  console.log('SMS verstuurd via Twilio naar', to, '— SID:', msg.sid);
  return msg;
}

async function notifyOrderReady(order) {
  if (!order.phone) return;
  const barName = getSetting('barName') || 'Zomerbar';
  const msg = `${barName}: Bestelling #${order.order_number} is klaar! Haal op aan de bar. Smakelijk! ☀️`;
  try { await sendSMS(order.phone, msg); }
  catch (e) { console.error('SMS mislukt:', e.message); }
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
  res.json(db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order,name').all());
});

app.post('/api/products', requireAuth, (req, res) => {
  const { name, category, price, icon, vat_type, stock, low_stock } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Naam en prijs zijn verplicht' });
  const maxOrd = db.prepare('SELECT MAX(sort_order) as m FROM products').get().m || 0;
  const r = db.prepare(`INSERT INTO products (name,category,price,icon,vat_type,stock,low_stock,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, category||'Overige', parseFloat(price), icon||'🍺', vat_type||'drinks', stock??-1, low_stock??5, maxOrd+1);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
  broadcast('product_updated', { product: p });
  res.json(p);
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const { name, category, price, icon, vat_type, stock, low_stock, active } = req.body;
  db.prepare(`UPDATE products SET name=?,category=?,price=?,icon=?,vat_type=?,stock=?,low_stock=?,active=? WHERE id=?`)
    .run(name, category, parseFloat(price), icon, vat_type, stock??-1, low_stock??5, active??1, req.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  broadcast('product_updated', { product: p });
  res.json(p);
});

app.patch('/api/products/:id/stock', requireAuth, (req, res) => {
  const { stock } = req.body;
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(stock, req.params.id);
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

app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(hydrate(o));
});

// Create order + SumUp checkout
app.post('/api/orders', async (req, res) => {
  const { items, method, note, table_ref, phone } = req.body;
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
  const amount = items.reduce((s, i) => s + i.price * i.qty, 0);
  let sumupCheckoutId = null;

  // Create SumUp checkout for card payments
  if (method === 'sumup') {
    try {
      const checkout = await sumupRequest('POST', '/v0.1/checkouts', {
        checkout_reference: id,
        amount: parseFloat(amount.toFixed(2)),
        currency: 'EUR',
        description: `Bestelling #${orderNumber} — Zomerbar`,
        redirect_url: null,
      });
      sumupCheckoutId = checkout.id;
    } catch(e) {
      console.error('SumUp checkout fout:', e.message);
    }
  }

  const status = method === 'cash' ? 'paid' : 'pending';
  db.prepare(`INSERT INTO orders (id,order_number,status,amount,method,sumup_checkout_id,note,phone,table_ref)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, orderNumber, status, amount, method||'sumup', sumupCheckoutId, note||'', phone||'', table_ref||'');

  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,name,icon,price,qty) VALUES (?,?,?,?,?,?)');
  items.forEach(i => insertItem.run(id, i.product_id||null, i.name, i.icon||'🍺', i.price, i.qty));

  // Deduct stock immediately for cash, wait for payment confirmation for card
  if (method === 'cash') {
    deductStock(items.map((i,_) => ({...i, product_id: i.product_id})), id);
  }

  const order = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
  broadcast('order_created', { order });
  res.json({ order, sumupCheckoutId });
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

// Poll SumUp checkout status
app.get('/api/orders/:id/payment-status', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Niet gevonden' });
  if (o.status !== 'pending' || !o.sumup_checkout_id) return res.json({ status: o.status });

  try {
    const checkout = await sumupRequest('GET', `/v0.1/checkouts/${o.sumup_checkout_id}`);
    if (checkout.status === 'PAID') {
      db.prepare("UPDATE orders SET status='paid', sumup_tx_id=?, updated_at=datetime('now') WHERE id=?")
        .run(checkout.transaction_id || null, o.id);
      const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
      deductStock(items, o.id);
      const updated = hydrate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
      broadcast('order_updated', { order: updated });
      return res.json({ status: 'paid', order: updated });
    }
    res.json({ status: checkout.status?.toLowerCase() || 'pending' });
  } catch(e) {
    res.json({ status: o.status });
  }
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

app.delete('/api/orders/:id', requireAuth, (req, res) => {
  db.prepare("UPDATE orders SET status='archived' WHERE id=?").run(req.params.id);
  broadcast('order_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Stats
app.get('/api/stats', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const stats = db.prepare(`
    SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as revenue,
      COUNT(CASE WHEN method='cash' THEN 1 END) as cash_count,
      COALESCE(SUM(CASE WHEN method='cash' THEN amount END),0) as cash_revenue,
      COUNT(CASE WHEN method='sumup' THEN 1 END) as card_count,
      COALESCE(SUM(CASE WHEN method='sumup' THEN amount END),0) as card_revenue
    FROM orders WHERE DATE(created_at)=? AND status NOT IN ('cancelled','archived','pending')
  `).get(today);
  const topProducts = db.prepare(`
    SELECT oi.name,oi.icon,SUM(oi.qty) as sold,SUM(oi.qty*oi.price) as revenue
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE DATE(o.created_at)=? AND o.status NOT IN ('cancelled','archived','pending')
    GROUP BY oi.name ORDER BY sold DESC LIMIT 8
  `).all(today);
  const lowStock = db.prepare('SELECT * FROM products WHERE stock>=0 AND stock<=low_stock AND active=1').all();
  res.json({ ...stats, top_products: topProducts, low_stock: lowStock });
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
    hasSumup: !!getSetting('sumupKey'),
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
    SELECT o.*, DATE(o.created_at) as day FROM orders o
    WHERE DATE(o.created_at) BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending')
    ORDER BY o.created_at ASC
  `).all(dateFrom, dateTo);

  const vatDrinks = parseFloat(getSetting('vatDrinks') || '6');
  const vatFood = parseFloat(getSetting('vatFood') || '12');

  // Group by day
  const days = {};
  orders.forEach(o => {
    if (!days[o.day]) days[o.day] = { date: o.day, orders: [], cash: 0, card: 0, total: 0, vat: {} };
    const d = days[o.day];
    const items = db.prepare('SELECT oi.*, p.vat_type FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(o.id);
    d.orders.push({ ...o, items });
    if (o.method === 'cash') d.cash += o.amount;
    else d.card += o.amount;
    d.total += o.amount;
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
  const totals = { cash: 0, card: 0, total: 0, vat: {}, order_count: orders.length };
  Object.values(days).forEach(d => {
    totals.cash += d.cash; totals.card += d.card; totals.total += d.total;
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
  if (!apiKey) throw new Error('Geen Billit API-sleutel ingesteld');
  const base = env === 'production' ? 'https://api.billit.be' : 'https://api.sandbox.billit.be';
  const r = await fetch(base + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'apiKey': apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.errors) ? JSON.stringify(data.errors) : (data.Description || 'Billit fout ' + r.status));
  return data;
}

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
    WHERE DATE(o.created_at) BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending')
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
      Name: barName,
      VATNumber: barVat || undefined,
      PartyType: 'Customer',
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
    WHERE DATE(o.created_at) BETWEEN ? AND ?
      AND o.status NOT IN ('cancelled','archived','pending')
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

// SPA fallback
app.get('*', (req, res) => {
  const file = req.path.slice(1) + '.html';
  const full = path.join(__dirname, 'public', file);
  if (fs.existsSync(full)) return res.sendFile(full);
  res.sendFile(path.join(__dirname, 'public', 'bestel.html'));
});

server.listen(PORT, () => console.log(`☀️  Zomerbar v4.0.0 op http://localhost:${PORT}`));
