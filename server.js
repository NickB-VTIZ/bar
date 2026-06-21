const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/zomerbar.db';

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Database setup ──────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    category  TEXT NOT NULL,
    price     REAL NOT NULL,
    icon      TEXT NOT NULL DEFAULT '🍺',
    vat_type  TEXT NOT NULL DEFAULT 'drinks',
    active    INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id         TEXT PRIMARY KEY,
    table_num  INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',
    amount     REAL NOT NULL DEFAULT 0,
    method     TEXT NOT NULL DEFAULT 'card',
    note       TEXT,
    invoice    TEXT,
    sumup_id   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '🍺',
    price      REAL NOT NULL,
    qty        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT NOT NULL,
    amount     REAL NOT NULL,
    method     TEXT NOT NULL,
    sumup_ref  TEXT,
    billit_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed default products if empty
const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (productCount === 0) {
  const insert = db.prepare(`INSERT INTO products (name, category, price, icon, vat_type, sort_order) VALUES (?,?,?,?,?,?)`);
  const defaults = [
    ['Pils',         'Bieren',    2.50, '🍺', 'drinks', 1],
    ['Tripel',       'Bieren',    3.50, '🍺', 'drinks', 2],
    ['Fruitbier',    'Bieren',    3.00, '🍻', 'drinks', 3],
    ['Cola',         'Soft',      2.00, '🥤', 'drinks', 4],
    ['Water',        'Soft',      1.50, '💧', 'drinks', 5],
    ['Ice Tea',      'Soft',      2.50, '🧃', 'drinks', 6],
    ['Aperol Spritz','Cocktails', 7.00, '🍹', 'drinks', 7],
    ['Mojito',       'Cocktails', 8.00, '🍹', 'drinks', 8],
    ['Toast HAC',    'Eten',      5.50, '🥪', 'food',   9],
    ['Plankje',      'Eten',      9.00, '🧀', 'food',   10],
    ['Frietjes',     'Eten',      3.50, '🍟', 'food',   11],
  ];
  defaults.forEach(p => insert.run(...p));
}

// ── Express app ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket broadcast ─────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'init', orders: getActiveOrders() }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── Helper ──────────────────────────────────────────────────────
function getActiveOrders() {
  const orders = db.prepare(`
    SELECT o.*, GROUP_CONCAT(
      json_object('id',oi.id,'name',oi.name,'icon',oi.icon,'price',oi.price,'qty',oi.qty)
    ) as items_json
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status != 'archived'
    GROUP BY o.id
    ORDER BY
      CASE o.status WHEN 'new' THEN 0 WHEN 'making' THEN 1 WHEN 'done' THEN 2 END,
      o.created_at ASC
  `).all();
  return orders.map(o => ({
    ...o,
    items: o.items_json ? o.items_json.split('},{').map((s,i,a) => {
      try { return JSON.parse(i===0?s+(a.length>1?'}':''):i===a.length-1?'{'+s:'{'+s+'}'); } catch(e) { return null; }
    }).filter(Boolean) : [],
    invoice: o.invoice ? JSON.parse(o.invoice) : null,
  }));
}

function getOrderById(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  return { ...o, items, invoice: o.invoice ? JSON.parse(o.invoice) : null };
}

let orderCounter = (() => {
  const last = db.prepare("SELECT id FROM orders ORDER BY created_at DESC LIMIT 1").get();
  if (!last) return 1;
  const m = last.id.match(/(\d+)$/);
  return m ? parseInt(m[1]) + 1 : 1;
})();

function nextOrderId() {
  return 'TX-' + String(orderCounter++).padStart(4, '0');
}

// ── REST API ────────────────────────────────────────────────────

// Products
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order').all();
  res.json(products);
});

app.post('/api/products', (req, res) => {
  const { name, category, price, icon, vat_type } = req.body;
  if (!name || !category || price == null) return res.status(400).json({ error: 'Naam, categorie en prijs zijn verplicht' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM products').get().m || 0;
  const r = db.prepare('INSERT INTO products (name,category,price,icon,vat_type,sort_order) VALUES (?,?,?,?,?,?)')
    .run(name, category, parseFloat(price), icon||'🍺', vat_type||'drinks', maxOrder+1);
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
  broadcast('product_added', { product });
  res.json(product);
});

app.put('/api/products/:id', (req, res) => {
  const { name, category, price, icon, vat_type, active } = req.body;
  db.prepare('UPDATE products SET name=?,category=?,price=?,icon=?,vat_type=?,active=? WHERE id=?')
    .run(name, category, parseFloat(price), icon, vat_type, active??1, req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  broadcast('product_updated', { product });
  res.json(product);
});

app.delete('/api/products/:id', (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  broadcast('product_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Orders
app.get('/api/orders', (req, res) => {
  res.json(getActiveOrders());
});

app.get('/api/orders/table/:table', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE table_num=? AND status != 'archived'
    ORDER BY created_at DESC
  `).all(req.params.table);
  const result = orders.map(o => ({
    ...o,
    items: db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id),
    invoice: o.invoice ? JSON.parse(o.invoice) : null,
  }));
  res.json(result);
});

app.post('/api/orders', (req, res) => {
  const { table_num, items, amount, method, note, invoice, sumup_id } = req.body;
  if (!table_num || !items?.length) return res.status(400).json({ error: 'Tafel en items zijn verplicht' });
  const id = nextOrderId();
  db.prepare(`INSERT INTO orders (id,table_num,amount,method,note,invoice,sumup_id)
    VALUES (?,?,?,?,?,?,?)`).run(
    id, table_num, amount||0, method||'card', note||'',
    invoice ? JSON.stringify(invoice) : null, sumup_id||null
  );
  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,name,icon,price,qty) VALUES (?,?,?,?,?,?)');
  items.forEach(item => insertItem.run(id, item.product_id||null, item.name, item.icon||'🍺', item.price, item.qty));
  db.prepare('INSERT INTO transactions (order_id,amount,method,sumup_ref) VALUES (?,?,?,?)')
    .run(id, amount||0, method||'card', sumup_id||null);
  const order = getOrderById(id);
  broadcast('order_created', { order });
  res.json(order);
});

app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['new','making','done','archived'].includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(status, req.params.id);
  const order = getOrderById(req.params.id);
  broadcast('order_updated', { order });
  res.json(order);
});

app.delete('/api/orders/:id', (req, res) => {
  db.prepare("UPDATE orders SET status='archived', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  broadcast('order_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Stats / today
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(amount),0) as revenue,
      COUNT(CASE WHEN status='new' THEN 1 END) as open_orders,
      COUNT(CASE WHEN status='making' THEN 1 END) as making_orders,
      COUNT(CASE WHEN status='done' THEN 1 END) as done_orders
    FROM orders
    WHERE DATE(created_at) = ? AND status != 'archived'
  `).get(today);
  const byMethod = db.prepare(`
    SELECT method, COUNT(*) as count, COALESCE(SUM(amount),0) as total
    FROM orders WHERE DATE(created_at) = ? AND status != 'archived'
    GROUP BY method
  `).all(today);
  const topProducts = db.prepare(`
    SELECT oi.name, oi.icon, SUM(oi.qty) as sold, SUM(oi.qty*oi.price) as revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE DATE(o.created_at) = ? AND o.status != 'archived'
    GROUP BY oi.name ORDER BY sold DESC LIMIT 5
  `).all(today);
  res.json({ ...stats, by_method: byMethod, top_products: topProducts });
});

// Settings
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const result = {};
  rows.forEach(r => { try { result[r.key] = JSON.parse(r.value); } catch(e) { result[r.key] = r.value; } });
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  Object.entries(req.body).forEach(([k,v]) => upsert.run(k, JSON.stringify(v)));
  res.json({ ok: true });
});

// Transactions export
app.get('/api/transactions', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, o.table_num, o.note FROM transactions t
    JOIN orders o ON o.id = t.order_id
    ORDER BY t.created_at DESC LIMIT 500
  `).all();
  res.json(rows);
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// SPA fallback
app.get('*', (req, res) => {
  const file = req.path.replace('/', '') + '.html';
  const full = path.join(__dirname, 'public', file);
  if (fs.existsSync(full)) return res.sendFile(full);
  res.sendFile(path.join(__dirname, 'public', 'pos.html'));
});

server.listen(PORT, () => console.log(`☀️  Zomerbar draait op http://localhost:${PORT}`));
