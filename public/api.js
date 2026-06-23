window.API = (() => {
  let ws, listeners = {}, reconnectTimer;
  let adminToken = localStorage.getItem('zb_admin_token') || null;

  function on(e, fn) { (listeners[e] = listeners[e]||[]).push(fn); }
  function emit(e, d) { (listeners[e]||[]).forEach(fn=>fn(d)); (listeners['*']||[]).forEach(fn=>fn(e,d)); }

  function connect() {
    const proto = location.protocol==='https:'?'wss':'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { emit('ws_open'); clearTimeout(reconnectTimer); };
    ws.onclose = () => { emit('ws_close'); reconnectTimer = setTimeout(connect, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = e => { try { const d=JSON.parse(e.data); emit(d.type,d); } catch(_){} };
  }
  connect();

  async function req(method, url, body) {
    const headers = {'Content-Type':'application/json'};
    if (adminToken) headers['x-admin-token'] = adminToken;
    const r = await fetch(url, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (r.status === 401 && data.needsAuth) {
      // Session invalid — redirect to login
      localStorage.removeItem('zb_admin_token');
      adminToken = null;
      if (!location.pathname.includes('login')) {
        window.location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      }
      throw new Error('Niet ingelogd');
    }
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  return {
    on,
    setToken(t) { adminToken = t; if (t) localStorage.setItem('zb_admin_token', t); else localStorage.removeItem('zb_admin_token'); },
    getToken() { return adminToken; },
    auth: {
      login: (password) => req('POST', '/api/auth/login', { password }),
      check: () => req('GET', '/api/auth/check'),
      logout: () => req('POST', '/api/auth/logout'),
      changePassword: (newPassword) => req('POST', '/api/auth/change-password', { newPassword }),
    },
    products: {
      list: () => req('GET', '/api/products'),
      add: (p) => req('POST', '/api/products', p),
      update: (id, p) => req('PUT', `/api/products/${id}`, p),
      setStock: (id, stock) => req('PATCH', `/api/products/${id}/stock`, { stock }),
      remove: (id) => req('DELETE', `/api/products/${id}`),
      syncSumup: () => req('POST', '/api/products/sync-sumup'),
    },
    orders: {
      list: () => req('GET', '/api/orders'),
      get: (id) => req('GET', `/api/orders/${id}`),
      create: (o) => req('POST', '/api/orders', o),
      setStatus: (id, status) => req('PATCH', `/api/orders/${id}/status`, { status }),
      confirmPayment: (id, tx) => req('POST', `/api/orders/${id}/confirm-payment`, { sumup_tx_id: tx }),
      pollPayment: (id) => req('GET', `/api/orders/${id}/payment-status`),
      remove: (id) => req('DELETE', `/api/orders/${id}`),
    },
    stats: () => req('GET', '/api/stats'),
    cashbook: (from, to) => req('GET', `/api/cashbook?from=${from}&to=${to}`),
    invoice: {
      preview: (year, month) => req('GET', `/api/invoice/preview?year=${year}&month=${month}`),
      createMonthly: (year, month) => req('POST', '/api/invoice/monthly', { year, month }),
    },
    settings: {
      get: () => req('GET', '/api/settings'),
      save: (s) => req('POST', '/api/settings', s),
    },
    stock: { log: () => req('GET', '/api/stock/log') },
  };
})();
