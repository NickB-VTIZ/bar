// Zomerbar shared API client
window.ZomerbarAPI = (() => {
  const BASE = '';
  let ws = null;
  let listeners = {};
  let reconnectTimer = null;

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }
  function off(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(f => f !== fn);
  }
  function emit(event, data) {
    (listeners[event] || []).forEach(fn => fn(data));
    (listeners['*'] || []).forEach(fn => fn(event, data));
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { emit('ws_open'); clearTimeout(reconnectTimer); };
    ws.onclose = () => { emit('ws_close'); reconnectTimer = setTimeout(connectWS, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = e => {
      try { const d = JSON.parse(e.data); emit(d.type, d); } catch(_) {}
    };
  }
  connectWS();

  async function req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(BASE + url, opts);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  }

  return {
    on, off,
    products: {
      list: () => req('GET', '/api/products'),
      add: (p) => req('POST', '/api/products', p),
      update: (id, p) => req('PUT', `/api/products/${id}`, p),
      remove: (id) => req('DELETE', `/api/products/${id}`),
    },
    orders: {
      list: () => req('GET', '/api/orders'),
      forTable: (t) => req('GET', `/api/orders/table/${t}`),
      create: (o) => req('POST', '/api/orders', o),
      setStatus: (id, status) => req('PATCH', `/api/orders/${id}/status`, { status }),
      remove: (id) => req('DELETE', `/api/orders/${id}`),
    },
    stats: () => req('GET', '/api/stats'),
    transactions: () => req('GET', '/api/transactions'),
    settings: {
      get: () => req('GET', '/api/settings'),
      save: (s) => req('POST', '/api/settings', s),
    },
  };
})();
