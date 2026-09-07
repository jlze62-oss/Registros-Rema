// ===== ESTADO GLOBAL =====
// URL de producción del Apps Script. Se usa como respaldo cuando un
// dispositivo nuevo todavía no tiene nada guardado en Configuración, para
// que abrir el enlace ya conecte automáticamente sin pasos extra.
const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw07Uuzm1y80V0QCJsttW61QOmKqGPLXmksNYn2ZA-_S0gDFkIhxmNv-xc7enTcIATXUA/exec';
let currentUser = null;
let couples = [];
let config = {};
let users = [];
let currentFilter = 'all';
let editingCoupleId = null;
let docData = { acta: null, id: null, photo: null };
let detailCoupleId = null;
let syncTimer = null;
let lastSyncTime = null;
let pendingSync = new Set(); // IDs de parejas pendientes de sincronizar

// ===== ROLES =====
function isAdmin() { return currentUser && currentUser.role === 'admin'; }
function isRegPrincipal() { return currentUser && (currentUser.role === 'admin' || currentUser.role === 'registrador_principal' || currentUser.email === 'mcastillo'); }
function canSync() { return isAdmin() || isRegPrincipal(); } // puede hacer sincronización completa
function canEdit() { return isAdmin(); }
function canViewDocs() { return isAdmin() || isRegPrincipal(); }
function canRegister() { return currentUser && ['admin','registrador_principal','registrador'].includes(currentUser.role); }

// Candado adicional dentro de las funciones de Beca/Penalización/Cancelación
// (no solo ocultar el botón): así, aunque alguien las dispare a mano desde
// la consola del navegador, no se ejecutan si el usuario no es Admin.
function requireAdmin() {
  if (!isAdmin()) { showToast('Solo el Admin puede hacer esto', 'error'); return false; }
  return true;
}

// ===== INICIALIZACIÓN =====
window.addEventListener('load', () => {
  loadFromStorage();
  checkSession();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Trae la lista real de usuarios de Sheets en segundo plano, para que
  // cualquier persona con el enlace pueda entrar con la cuenta que el
  // Admin le haya creado, sin necesidad de configurar nada a mano.
  syncUsersFromServer();
});

function loadFromStorage() {
  config = JSON.parse(localStorage.getItem('rm_config') || '{}');
  if (!config.scriptUrl) {
    config.scriptUrl = DEFAULT_SCRIPT_URL;
    localStorage.setItem('rm_config', JSON.stringify(config));
  }
  if (!Array.isArray(config.paymentMethods)) config.paymentMethods = [];
  users = JSON.parse(localStorage.getItem('rm_users') || '[]');
  couples = JSON.parse(localStorage.getItem('rm_couples') || '[]');
  pendingSync = new Set(JSON.parse(localStorage.getItem('rm_pending') || '[]'));

  // Corregir penalizaciones que quedaron en metadatos pero no en historial de pagos
  let changed = false;
  couples.forEach((c, i) => {
    if (c.penalizacion && c.penalizacion.amount > 0) {
      const hasPenPayment = (c.payments || []).some(p => p.method === 'penalizacion');
      if (!hasPenPayment) {
        if (!couples[i].payments) couples[i].payments = [];
        couples[i].payments.push({
          id: 'PEN_FIX_' + c.id,
          coupleId: c.id,
          amount: -c.penalizacion.amount,
          date: c.penalizacion.date || new Date().toISOString().split('T')[0],
          receivedBy: 'Sistema REMA',
          method: 'penalizacion',
          note: '⚠️ Penalización: ' + (c.penalizacion.reason || '') + (c.penalizacion.notes ? ' — ' + c.penalizacion.notes : ''),
          registeredBy: c.penalizacion.registeredBy || 'Sistema',
          registeredAt: c.penalizacion.registeredAt || new Date().toISOString(),
        });
        changed = true;
      }
    }
    // Recalcular totales desde historial de pagos
    if (couples[i].payments && couples[i].payments.length > 0) {
      couples[i].amount = couples[i].payments.reduce((s, p) => s + (p.amount || 0), 0);
    }
  });
  if (changed) localStorage.setItem('rm_couples', JSON.stringify(couples));

  if (users.length === 0) {
    users = [
      { id: 1, name: 'Administrador', email: 'admin', password: 'admin123', role: 'admin' },
      { id: 2, name: 'Registrador', email: 'registro', password: 'registro123', role: 'registrador' }
    ];
    saveUsers();
  }
}

function savePendingSync() {
  localStorage.setItem('rm_pending', JSON.stringify([...pendingSync]));
}

function checkSession() {
  const session = sessionStorage.getItem('rm_session');
  if (session) { currentUser = JSON.parse(session); showApp(); }
}

function saveToStorage() { localStorage.setItem('rm_couples', JSON.stringify(couples)); }
function saveUsers() { localStorage.setItem('rm_users', JSON.stringify(users)); }

// ===== NÚMERO CONSECUTIVO =====
// Ordenados por fecha de registro (más antiguo = #1)
function getSortedByDate() {
  return [...couples].sort((a, b) => {
    const da = new Date(a.createdAt || a.regDate || '2099-01-01');
    const db = new Date(b.createdAt || b.regDate || '2099-01-01');
    return da - db;
  });
}
function getConsecutive(coupleId) {
  const sorted = getSortedByDate();
  const idx = sorted.findIndex(c => c.id === coupleId);
  return idx >= 0 ? idx + 1 : '—';
}

// ===== CONFIGURACIÓN =====
function saveConfig() {
  config = {
    eventName: document.getElementById('cfg-event-name').value,
    dateStart: document.getElementById('cfg-date-start').value,
    dateEnd: document.getElementById('cfg-date-end').value,
    cost: parseFloat(document.getElementById('cfg-cost').value) || 0,
    sheetId: document.getElementById('cfg-sheet-id').value,
    scriptUrl: document.getElementById('cfg-script-url').value,
  };
  localStorage.setItem('rm_config', JSON.stringify(config));
  document.getElementById('cfg-msg').classList.remove('hidden');
  setTimeout(() => document.getElementById('cfg-msg').classList.add('hidden'), 2500);
  showToast('Configuración guardada', 'success');
  refreshDashboard();
  pushConfigToServer();
}

// Sube solo los datos del evento (nombre, fechas, costo) a la hoja
// Configuracion — la URL del script y el ID de la hoja se quedan locales
// a propósito, para que un dispositivo nunca pueda pisarle a otro la
// conexión que ya tiene funcionando.
async function pushConfigToServer() {
  if (!config.scriptUrl) return;
  try {
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'saveConfig',
        config: {
          eventName: config.eventName || '',
          dateStart: config.dateStart || '',
          dateEnd: config.dateEnd || '',
          cost: config.cost || 0,
          paymentMethods: JSON.stringify(config.paymentMethods || []),
        }
      })
    });
  } catch (e) { console.warn('No se pudo sincronizar configuración al servidor:', e); }
}

// Descarga el nombre/fechas/costo del evento desde Sheets — así un
// dispositivo nuevo (o uno al que se le borró el caché) no necesita que
// alguien vuelva a teclear la configuración a mano.
async function syncConfigFromServer() {
  if (!config.scriptUrl) return false;
  try {
    const res = await fetch(config.scriptUrl + '?action=getConfig', { mode: 'cors' });
    if (!res.ok) return false;
    const data = await res.json();
    if (data && (data.eventName || data.cost)) {
      config.eventName = data.eventName || config.eventName || '';
      config.dateStart = data.dateStart || config.dateStart || '';
      config.dateEnd = data.dateEnd || config.dateEnd || '';
      config.cost = parseFloat(data.cost) || config.cost || 0;
      if (data.paymentMethods) {
        try {
          const parsed = JSON.parse(data.paymentMethods);
          if (Array.isArray(parsed)) config.paymentMethods = parsed;
        } catch (e) { /* valor viejo o inválido, se ignora */ }
      }
      localStorage.setItem('rm_config', JSON.stringify(config));
      populateMethodSelects();
      return true;
    }
  } catch (e) { console.warn('No se pudo sincronizar configuración:', e); }
  return false;
}

// ===== MODOS DE PAGO CONFIGURABLES =====
// Efectivo y Transferencia siempre existen (hardcoded). Aquí se administran
// modos adicionales (Oficina, Depósito, Cheque, etc.) que el Admin agrega
// desde Configuración. Se guardan en config.paymentMethods y se sincronizan
// a Sheets igual que el resto de la configuración del evento.
function getMethodMeta(key) {
  const builtIn = {
    efectivo: { label: 'Efectivo', icon: '💵' },
    transferencia: { label: 'Transferencia', icon: '🏦' },
    beca: { label: 'Beca REMA', icon: '🎓' },
    penalizacion: { label: 'Penalización', icon: '⚠️' },
    cancelacion: { label: 'Cancelación', icon: '❌' },
  };
  if (builtIn[key]) return builtIn[key];
  const custom = (config.paymentMethods || []).find(m => m.key === key);
  if (custom) return { label: custom.label, icon: custom.icon || '💳' };
  return builtIn.efectivo; // pagos viejos sin "method" se contaban como efectivo
}

function slugifyMethod(str) {
  return String(str).toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Agrega las opciones de modos de pago personalizados a los 3 <select>
// donde se elige el modo (nuevo abono, editar abono, primer abono al
// registrar pareja). Quita las que había agregado antes para no duplicar.
function populateMethodSelects() {
  ['pay-method', 'edit-pay-method', 'cp-method'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    (config.paymentMethods || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = (m.icon || '💳') + ' ' + m.label;
      opt.setAttribute('data-custom', '1');
      sel.appendChild(opt);
    });
  });
}

function renderPaymentMethodsList() {
  const el = document.getElementById('payment-methods-list');
  if (!el) return;
  const methods = config.paymentMethods || [];
  el.innerHTML = methods.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:4px 0;">Aún no has agregado modos de pago adicionales.</div>'
    : methods.map(m =>
        '<div class="detail-row"><span class="detail-lbl">' + m.icon + ' ' + esc(m.label) + '</span>' +
          '<button onclick="removePaymentMethod(\'' + m.key + '\')" style="background:none;border:none;color:#C0392B;font-size:13px;cursor:pointer;">🗑 Quitar</button>' +
        '</div>'
      ).join('');
}

function addPaymentMethod() {
  const labelEl = document.getElementById('new-method-label');
  const iconEl = document.getElementById('new-method-icon');
  const label = labelEl.value.trim();
  if (!label) { showToast('Escribe un nombre para el modo de pago', 'error'); return; }
  const key = slugifyMethod(label);
  const reserved = ['efectivo', 'transferencia', 'beca', 'penalizacion', 'cancelacion'];
  if (!config.paymentMethods) config.paymentMethods = [];
  if (!key || reserved.includes(key) || config.paymentMethods.some(m => m.key === key)) {
    showToast('Ese modo de pago ya existe', 'error'); return;
  }
  config.paymentMethods.push({ key, label, icon: iconEl.value.trim() || '💳' });
  localStorage.setItem('rm_config', JSON.stringify(config));
  labelEl.value = ''; iconEl.value = '';
  renderPaymentMethodsList();
  populateMethodSelects();
  pushConfigToServer();
  showToast('Modo de pago agregado ✓', 'success');
}

function removePaymentMethod(key) {
  if (!confirm('¿Quitar este modo de pago? Los abonos ya registrados con este modo conservan su historial, pero ya no podrás elegirlo para nuevos abonos.')) return;
  config.paymentMethods = (config.paymentMethods || []).filter(m => m.key !== key);
  localStorage.setItem('rm_config', JSON.stringify(config));
  renderPaymentMethodsList();
  populateMethodSelects();
  pushConfigToServer();
  showToast('Modo de pago eliminado', '');
}

// Orden en el que se muestran los modos en el resumen del Inicio
function methodDisplayOrder() {
  const custom = (config.paymentMethods || []).map(m => m.key);
  return ['efectivo', 'transferencia', ...custom, 'penalizacion', 'beca', 'cancelacion'];
}

// Tabla "Resumen por modo de pago" del Inicio — solo Admin / Reg. Principal
// (ver .finance-restricted en showApp()). Cuenta y suma TODOS los abonos
// (incluye becas y penalizaciones, que se ven como montos negativos, igual
// que en el detalle de cada pareja).
function renderPaymentBreakdown() {
  const el = document.getElementById('payment-breakdown-body');
  if (!el) return;
  const totals = {};
  couples.forEach(c => {
    (c.payments || []).forEach(p => {
      const key = p.method || 'efectivo';
      if (!totals[key]) totals[key] = { count: 0, sum: 0 };
      totals[key].count++;
      totals[key].sum += (p.amount || 0);
    });
  });
  const order = methodDisplayOrder();
  const keys = Object.keys(totals).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  const totalEl = document.getElementById('payment-breakdown-total');
  if (keys.length === 0) {
    el.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin abonos registrados aún.</div>';
    if (totalEl) totalEl.textContent = '$0.00';
    return;
  }
  let grandTotal = 0;
  el.innerHTML = keys.map(key => {
    const meta = getMethodMeta(key);
    const t = totals[key];
    grandTotal += t.sum;
    return '<div class="detail-row"><span class="detail-lbl">' + meta.icon + ' ' + esc(meta.label) + ' (' + t.count + ')</span>' +
      '<span class="detail-val" style="color:' + (t.sum < 0 ? '#C0392B' : '#1A1A1A') + '">' + (t.sum < 0 ? '−' : '') + '$' + fmtMoney(Math.abs(t.sum)) + '</span></div>';
  }).join('');
  if (totalEl) totalEl.textContent = '$' + fmtMoney(grandTotal);
}

// ===== LOGIN =====
// Descarga la lista de usuarios (con contraseña) desde Sheets y, si trae
// algo, reemplaza la lista local. Así un dispositivo que nunca ha entrado
// ya conoce a los usuarios que el Admin creó en otro dispositivo.
async function syncUsersFromServer() {
  if (!config.scriptUrl) return false;
  try {
    const res = await fetch(config.scriptUrl + '?action=getUsers', { mode: 'cors' });
    if (!res.ok) return false;
    const data = await res.json();
    if (data && Array.isArray(data.users) && data.users.length > 0) {
      users = data.users;
      saveUsers();
      return true;
    }
  } catch (e) { console.warn('No se pudo sincronizar usuarios:', e); }
  return false;
}

async function doLogin() {
  const email = document.getElementById('login-user').value.trim().toLowerCase();
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('btn-login');

  let user = users.find(u => u.email.toLowerCase() === email && u.password === pass);
  if (!user) {
    // No coincide con lo que ya tenemos local — antes de rechazar, damos
    // un intento a traer la lista fresca de Sheets (por si el Admin creó
    // o cambió este usuario y este dispositivo aún no lo sabía).
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
    await syncUsersFromServer();
    if (btn) { btn.disabled = false; btn.textContent = 'Ingresar'; }
    user = users.find(u => u.email.toLowerCase() === email && u.password === pass);
  }
  if (!user) { errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  currentUser = user;
  sessionStorage.setItem('rm_session', JSON.stringify(user));
  showApp();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !document.getElementById('screen-login').classList.contains('hidden')) doLogin();
});

function doLogout() {
  stopAutoSync();
  currentUser = null;
  sessionStorage.removeItem('rm_session');
  document.getElementById('screen-app').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  toggleSidebar(false);
}

function showApp() {
  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');

  const admin = isAdmin();
  const regPrincipal = isRegPrincipal();

  // Mostrar/ocultar elementos según rol
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !admin));
  // El resumen financiero (total recaudado / saldo pendiente) solo lo ven admin y registrador principal
  document.querySelectorAll('.finance-restricted').forEach(el => el.classList.toggle('hidden', !regPrincipal));

  // Nombre y rol en sidebar
  document.getElementById('nav-avatar').textContent = (currentUser.name || 'U').charAt(0).toUpperCase();
  document.getElementById('nav-username').textContent = currentUser.name;
  document.getElementById('nav-role').textContent =
    admin ? 'Administrador' :
    regPrincipal ? 'Reg. Principal' : 'Registrador';

  // Cargar config en formulario si es admin
  if (admin) {
    document.getElementById('cfg-event-name').value = config.eventName || '';
    document.getElementById('cfg-date-start').value = config.dateStart || '';
    document.getElementById('cfg-date-end').value = config.dateEnd || '';
    document.getElementById('cfg-cost').value = config.cost || '';
    document.getElementById('cfg-sheet-id').value = config.sheetId || '';
    document.getElementById('cfg-script-url').value = config.scriptUrl || '';
    renderPaymentMethodsList();
  }

  // Los modos de pago adicionales aplican para cualquier rol que registre abonos
  populateMethodSelects();

  showView('dashboard');

  // Sincronizar al iniciar sesión solo si el script está configurado correctamente
  // Auto-sync desactivado temporalmente hasta confirmar que Apps Script devuelve datos correctos
  // if (config.scriptUrl) {
  //   syncFromSheets();
  //   startAutoSync();
  // }

  // Dispositivo nuevo sin datos locales todavía: trae automáticamente lo
  // que ya existe en Sheets (parejas y pagos), en vez de dejar la app
  // vacía hasta que alguien presione "Actualizar lista" a mano.
  if (couples.length === 0 && config.scriptUrl) {
    downloadFromSheets();
  }

  // Igual para la configuración del evento (nombre, fechas, costo): sin
  // esto, un dispositivo nuevo muestra "Sin evento configurado" y todo en
  // $0.00 aunque las parejas y pagos ya se hayan descargado bien.
  if (!config.eventName && config.scriptUrl) {
    syncConfigFromServer().then(ok => {
      if (!ok) return;
      refreshDashboard();
      if (isAdmin()) {
        document.getElementById('cfg-event-name').value = config.eventName || '';
        document.getElementById('cfg-date-start').value = config.dateStart || '';
        document.getElementById('cfg-date-end').value = config.dateEnd || '';
        document.getElementById('cfg-cost').value = config.cost || '';
      }
    });
  }
}

// ===== AUTO-SYNC CADA 3 MINUTOS =====
function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (config.scriptUrl && currentUser) {
      syncFromSheets(true); // silent = true
    }
  }, 3 * 60 * 1000); // 3 minutos
}

function stopAutoSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// ===== NAVEGACIÓN =====
function showView(view) {
  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.style.display = 'none'; });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) { viewEl.classList.add('active'); viewEl.style.display = 'block'; }
  const navEl = document.querySelector('[data-view="' + view + '"]');
  if (navEl) navEl.classList.add('active');
  const titles = { dashboard: 'Inicio', couples: 'Matrimonios', payments: 'Pagos', documents: 'Documentos', config: 'Configuración', users: 'Usuarios', becas: 'Becas' };
  document.getElementById('topbar-title').textContent = titles[view] || view;
  document.getElementById('btn-new-couple').style.display = ['couples', 'dashboard'].includes(view) ? 'flex' : 'none';
  toggleSidebar(false);
  window.scrollTo(0, 0);
  if (view === 'dashboard') refreshDashboard();
  if (view === 'couples') renderCouples();
  if (view === 'payments') renderPayments();
  if (view === 'documents') renderDocuments();
  if (view === 'config') renderPaymentMethodsList();
  if (view === 'users') renderUsers();
  if (view === 'becas') renderBecas();
}

function toggleSidebar(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !document.getElementById('sidebar').classList.contains('open');
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebar-overlay').classList.toggle('hidden', !open);
}

// ===== HELPERS =====
function getTotalPaid(c) {
  if (c.payments && c.payments.length > 0) {
    const total = c.payments.reduce((s, p) => s + (p.amount || 0), 0);
    return Math.max(0, total); // nunca mostrar negativo
  }
  return c.amount || 0;
}
function getPayStatus(c) {
  const cost = config.cost || 0;
  const paid = getTotalPaid(c);
  if (cost > 0 && paid >= cost) return 'paid';
  if (paid > 0) return 'partial';
  return 'nopay';
}
function getDocsStatus(c) {
  const d = c.docs || {};
  const done = [d.acta, d.idHim, d.idHer, d.photo].filter(Boolean).length;
  return { done, total: 4, complete: done === 4 };
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtMoney(n) {
  return (parseFloat(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const p = dateStr.split('-');
  if (p.length < 3) return dateStr;
  const m = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return parseInt(p[2]) + ' ' + m[parseInt(p[1])-1] + ' ' + p[0];
}

// ===== MERGE DE ABONOS (local + Sheets, sin perder ninguno) =====
// Combina por ID: nunca descarta un lado solo porque el otro no esté
// vacío. Si el mismo ID de abono existe en ambos lados (p. ej. se editó
// un abono), se queda con la versión más reciente según editedAt/
// registeredAt. Esto evita que un dispositivo "borre" visualmente los
// abonos que otro registrador ya subió a Sheets.
function mergePayments(localPayments, sheetPayments) {
  const map = {};
  (sheetPayments || []).forEach(p => { if (p && p.id) map[p.id] = p; });
  (localPayments || []).forEach(p => {
    if (!p || !p.id) return;
    const existing = map[p.id];
    if (!existing) { map[p.id] = p; return; }
    const localTime = new Date(p.editedAt || p.registeredAt || 0).getTime();
    const sheetTime = new Date(existing.editedAt || existing.registeredAt || 0).getTime();
    map[p.id] = localTime >= sheetTime ? p : existing;
  });
  return Object.values(map);
}

// ===== DASHBOARD =====
function refreshDashboard() {
  const cost = config.cost || 0;
  document.getElementById('event-name-banner').textContent = config.eventName || 'Sin evento configurado';
  const ds = config.dateStart ? formatDate(config.dateStart) : '—';
  const de = config.dateEnd ? formatDate(config.dateEnd) : '';
  document.getElementById('event-dates-banner').textContent = de ? ds + ' – ' + de : ds;
  document.getElementById('event-cost-banner').innerHTML = '$' + fmtMoney(cost) + '<br><span style="font-size:10px;opacity:0.7">por pareja</span>';
  document.getElementById('stat-couples').textContent = couples.length;
  document.getElementById('stat-paid').textContent = couples.filter(c => getPayStatus(c) === 'paid').length;
  document.getElementById('stat-docs').textContent = couples.filter(c => getDocsStatus(c).complete).length;
  document.getElementById('stat-pending').textContent = couples.filter(c => getPayStatus(c) !== 'paid').length;
  const totalCollected = couples.reduce((s, c) => s + getTotalPaid(c), 0);
  const totalPending = Math.max(0, couples.length * cost - totalCollected);
  const pct = couples.length > 0 && cost > 0 ? Math.round(totalCollected / (couples.length * cost) * 100) : 0;
  document.getElementById('total-collected').textContent = '$' + fmtMoney(totalCollected);
  document.getElementById('total-pending').textContent = '$' + fmtMoney(totalPending);
  document.getElementById('progress-fill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('pct-badge').textContent = pct + '%';
  renderPaymentBreakdown();
  const recent = [...couples].sort((a, b) => new Date(b.createdAt||b.regDate) - new Date(a.createdAt||a.regDate)).slice(0, 5);
  document.getElementById('recent-list').innerHTML = recent.length === 0
    ? '<p style="color:#888;font-size:13px;padding:8px 0;">No hay registros aún.</p>'
    : recent.map(coupleItemHTML).join('');
}

// ===== COUPLES =====
function coupleItemHTML(c) {
  const status = getPayStatus(c);
  const paid = getTotalPaid(c);
  const docsStatus = getDocsStatus(c);
  const num = getConsecutive(c.id);
  const badgeMap = { paid: ['badge-paid','Pagado'], partial: ['badge-partial','Parcial'], nopay: ['badge-nopay','Sin pago'] };
  const [bClass, bText] = badgeMap[status];
  const docBadge = docsStatus.complete
    ? '<span class="badge badge-docs-ok" style="margin-left:4px">Docs ✓</span>'
    : '<span class="badge badge-docs-pend" style="margin-left:4px">Docs ' + docsStatus.done + '/4</span>';
  const becaBadge = c.beca ? '<span class="badge badge-becada" style="margin-left:4px">🎓</span>' : '';
  const penBadge = c.penalizacion ? '<span class="badge badge-penalizada" style="margin-left:4px">⚠️</span>' : '';
  const cancelBadge = c.cancelacion ? '<span class="badge badge-cancelada" style="margin-left:4px">❌ ' + (c.cancelacion.type === 'credito' ? 'Crédito' : 'Cancelada') + '</span>' : '';
  return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
    '<div class="couple-num">#' + num + '</div>' +
    '<div class="couple-info">' +
      '<div class="couple-names">' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
      '<div class="couple-meta">' + formatDate(c.regDate) + docBadge + becaBadge + penBadge + cancelBadge + '</div>' +
    '</div>' +
    '<div class="couple-right">' +
      '<div class="couple-amount">$' + fmtMoney(paid) + '</div>' +
      '<span class="badge ' + bClass + '">' + bText + '</span>' +
    '</div>' +
  '</div>';
}

function renderCouples() {
  const search = (document.getElementById('search-couples').value || '').toLowerCase();
  const list = couples.filter(c => {
    if (search && !(c.him + ' ' + c.her).toLowerCase().includes(search)) return false;
    const s = getPayStatus(c);
    if (currentFilter === 'paid') return s === 'paid';
    if (currentFilter === 'partial') return s === 'partial';
    if (currentFilter === 'nopay') return s === 'nopay';
    return true;
  });
  const el = document.getElementById('couples-list');
  const empty = document.getElementById('couples-empty');
  if (list.length === 0) { el.innerHTML = ''; empty.classList.remove('hidden'); }
  else { empty.classList.add('hidden'); el.innerHTML = list.map(coupleItemHTML).join(''); }
}

function filterCouples() { renderCouples(); }
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCouples();
}

// ===== PAYMENTS VIEW =====
function renderPayments() {
  const el = document.getElementById('payments-list');
  const allPayments = [];
  couples.forEach(c => {
    (c.payments || []).forEach(p => allPayments.push({ ...p, him: c.him, her: c.her }));
  });
  if (allPayments.length === 0) { el.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">No hay abonos registrados aún.</p>'; return; }
  allPayments.sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = allPayments.map(p => {
    const meta = getMethodMeta(p.method);
    const icon = meta.icon;
    const methodLabel = meta.label;
    return '<div class="couple-item" onclick="openDetail(\'' + p.coupleId + '\')">' +
      '<div class="couple-avatar" style="font-size:20px">' + icon + '</div>' +
      '<div class="couple-info">' +
        '<div class="couple-names">' + esc(p.him) + ' & ' + esc(p.her) + '</div>' +
        '<div class="couple-meta">' + formatDate(p.date) + ' · ' + esc(p.receivedBy || '—') + (p.note ? ' · "' + esc(p.note) + '"' : '') + '</div>' +
      '</div>' +
      '<div class="couple-right">' +
        '<div style="font-size:15px;color:#1E7B3C;font-weight:600">$' + fmtMoney(p.amount) + '</div>' +
        '<span class="badge" style="background:#EAF1FB;color:#1B5FA8">' + methodLabel + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ===== DOCUMENTS VIEW =====
function renderDocuments() {
  const el = document.getElementById('docs-list');
  if (couples.length === 0) { el.innerHTML = '<div class="card"><p style="color:#888;font-size:13px;">No hay registros.</p></div>'; return; }
  const sorted = [...couples].sort((a, b) => getDocsStatus(a).done - getDocsStatus(b).done);
  el.innerHTML = sorted.map(c => {
    const d = c.docs || {};
    const docsStatus = getDocsStatus(c);
    const items = [{ key:'acta', icon:'📋', label:'Acta' }, { key:'idHim', icon:'🪪', label:'ID Él' }, { key:'idHer', icon:'🪪', label:'ID Ella' }, { key:'photo', icon:'📷', label:'Foto' }];
    const docIcons = items.map(i =>
      '<div style="text-align:center;opacity:' + (d[i.key] ? 1 : 0.2) + '">' +
        '<div style="font-size:20px">' + i.icon + '</div>' +
        '<div style="font-size:9px;color:' + (d[i.key] ? '#1E7B3C' : '#888') + '">' + i.label + '</div>' +
      '</div>'
    ).join('');
    return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
      '<div class="couple-avatar" style="font-size:13px;background:' + (docsStatus.complete ? '#EAF7EE' : '#FFF4E5') + '">' +
        '<span style="color:' + (docsStatus.complete ? '#1E7B3C' : '#B06000') + '">' + docsStatus.done + '/4</span>' +
      '</div>' +
      '<div class="couple-info">' +
        '<div class="couple-names">' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
        '<div style="display:flex;gap:14px;margin-top:6px">' + docIcons + '</div>' +
      '</div>' +
      '<div class="couple-right">' +
        (docsStatus.complete ? '<span class="badge badge-docs-ok">Completo</span>' : '<span class="badge badge-docs-pend">Pendiente</span>') +
      '</div>' +
    '</div>';
  }).join('');
}

// ===== DETAIL MODAL =====
function openDetail(id) {
  const c = couples.find(x => x.id === id);
  if (!c) return;
  detailCoupleId = id;
  renderDetailModal(c);
  document.getElementById('modal-detail').classList.remove('hidden');
}

function renderDetailModal(c) {
  const num = getConsecutive(c.id);
  document.getElementById('detail-title').textContent = '#' + num + ' · ' + c.him + ' & ' + c.her;
  const cost = config.cost || 0;
  // Asegurar que payments siempre sea array válido
  const payments = (c.payments || []).filter(p => p && p.amount > 0);
  const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0) || (c.amount || 0);
  const pending = Math.max(0, cost - totalPaid);
  const docsStatus = getDocsStatus(c);
  const d = c.docs || {};
  // Desglose por modo de pago (la Beca se muestra aparte, en su propia sección)
  const methodTotals = {};
  payments.filter(p => p.method !== 'beca').forEach(p => {
    const key = p.method || 'efectivo';
    methodTotals[key] = (methodTotals[key] || 0) + p.amount;
  });
  const methodRowsHTML = Object.keys(methodTotals).map(key => {
    const meta = getMethodMeta(key);
    return '<div class="detail-row"><span class="detail-lbl">' + meta.icon + ' ' + esc(meta.label) + '</span><span class="detail-val">$' + fmtMoney(methodTotals[key]) + '</span></div>';
  }).join('');

  // Historial de pagos
  let paymentsHTML = payments.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin abonos aún — usa el botón verde abajo.</div>'
    : '<div class="payment-history">' + payments.map((p, i) => {
        const acum = payments.slice(0, i + 1).reduce((s, x) => s + x.amount, 0);
        const isNeg = p.amount < 0;
        const isPen = p.method === 'penalizacion';
        const isBeca = p.method === 'beca';
        const icon = getMethodMeta(p.method).icon;
        const isAdmin = currentUser && currentUser.role === 'admin';
        return '<div class="payment-item">' +
          '<div class="payment-dot ' + (i === 0 ? 'first' : '') + '" style="background:' + (isPen ? '#B06000' : isBeca ? '#1E7B3C' : '#1E7B3C') + '"></div>' +
          '<div class="payment-info">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<div class="payment-amount" style="color:' + (isNeg ? '#C0392B' : '#1A1A1A') + '">' + icon + ' ' + (isNeg ? '−' : '') + '$' + fmtMoney(Math.abs(p.amount)) + '</div>' +
              '<div style="display:flex;gap:6px;">' +
                (isAdmin && !isPen && !isBeca ? '<button onclick="openEditPaymentModal(\'' + c.id + '\',\'' + p.id + '\')" style="background:#EAF1FB;border:none;border-radius:6px;padding:3px 8px;font-size:11px;color:#1B5FA8;cursor:pointer;">✏️ Editar</button>' : '') +
                (isAdmin ? '<button onclick="deletePayment(\'' + c.id + '\',\'' + p.id + '\')" style="background:none;border:none;color:#ddd;font-size:16px;cursor:pointer;padding:0 0 0 4px;">✕</button>' : '') +
              '</div>' +
            '</div>' +
            '<div class="payment-meta">' + formatDate(p.date) + ' · ' + esc(p.receivedBy || '—') + ' · ' + getMethodMeta(p.method).label + '</div>' +
            (p.note ? '<div class="payment-note">"' + esc(p.note) + '"</div>' : '') +
            '<div class="payment-acum" style="color:' + (acum < 0 ? '#C0392B' : '#1E7B3C') + '">Acumulado hasta aquí: $' + fmtMoney(acum) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';

  // Documentos con botones Ver / Subir
  // La identificación va separada en dos (Él y Ella) porque siempre son
  // dos documentos distintos. Solo "Foto juntos" tiene botón de Descargar
  // — acta e identificaciones solo necesitan verse dentro de la app.
  const docItems = [
    { key: 'acta', label: 'Acta de matrimonio', icon: '📋' },
    { key: 'idHim', label: 'Identificación de Él', icon: '🪪' },
    { key: 'idHer', label: 'Identificación de Ella', icon: '🪪' },
    { key: 'photo', label: 'Foto juntos', icon: '📷' },
  ];
  const docRows = docItems.map(item => {
    const has = d[item.key];
    const canSee = canViewDocs();
    return '<div class="detail-row">' +
      '<span class="detail-lbl">' + item.icon + ' ' + item.label + '</span>' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="font-size:12px;color:' + (has ? '#1E7B3C' : '#B06000') + '">' + (has ? '✓ Cargado' : '⏳ Pendiente') + '</span>' +
        (has && canSee ? '<button onclick="viewDoc(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-view">Ver</button>' : '') +
        (has && canSee && item.key === 'photo' ? '<button onclick="downloadDoc(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-download">⬇ Descargar</button>' : '') +
        (canSee && has ? '<button onclick="openDocUpload(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-replace">Reemplazar</button>' : '') +
        (!has ? '<button onclick="openDocUpload(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-upload">+ Subir</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  const logHTML = (c.docLog || []).slice(-8).reverse().map(l =>
    '<div class="doc-log-item"><span class="log-time">' + esc(l.ts) + '</span> ' + esc(l.user) + ' subió ' + esc(l.doc) + '</div>'
  ).join('') || '<div style="color:#aaa;font-size:12px;">Sin actividad</div>';

  // Botones del footer según rol — se actualizan dinámicamente
  const editBtn = document.getElementById('btn-edit-couple');
  const adminBtns = document.getElementById('admin-action-btns');
  const cancelBtn = document.querySelector('.btn-cancelacion');
  const deleteBtn = document.querySelector('.btn-delete');
  const becaBtn = document.querySelector('.btn-beca');
  const penBtn = document.querySelector('.btn-penalizacion');

  if (editBtn) editBtn.style.display = canEdit() ? '' : 'none';
  if (adminBtns) adminBtns.style.display = canEdit() ? 'flex' : 'none';
  if (cancelBtn) cancelBtn.style.display = canEdit() ? '' : 'none';
  if (deleteBtn) deleteBtn.style.display = canEdit() ? '' : 'none';
  // Beca y Penalización: solo Admin (antes se buscaban pero nunca se ocultaban)
  if (becaBtn) becaBtn.style.display = canEdit() ? '' : 'none';
  if (penBtn) penBtn.style.display = canEdit() ? '' : 'none';

  document.getElementById('detail-body').innerHTML =
    '<div class="section-label">Participantes</div>' +
    '<div class="detail-row"><span class="detail-lbl">No. consecutivo</span><span class="detail-val" style="font-size:16px;font-weight:700;color:#7C2D3E">#' + num + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Él</span><span class="detail-val">' + esc(c.him) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Ella</span><span class="detail-val">' + esc(c.her) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Tel. él</span><span class="detail-val">' + esc(c.telHim || '—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Tel. ella</span><span class="detail-val">' + esc(c.telHer || '—') + '</span></div>' +
    (c.emailHim ? '<div class="detail-row"><span class="detail-lbl">Email él</span><span class="detail-val" style="font-size:12px">' + esc(c.emailHim) + '</span></div>' : '') +
    (c.emailHer ? '<div class="detail-row"><span class="detail-lbl">Email ella</span><span class="detail-val" style="font-size:12px">' + esc(c.emailHer) + '</span></div>' : '') +

    '<div class="section-label mt16">Resumen de pago</div>' +
    '<div class="detail-row"><span class="detail-lbl">Costo total</span><span class="detail-val">$' + fmtMoney(cost) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Total pagado</span><span class="detail-val" style="color:#1E7B3C;font-weight:600">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Pendiente</span><span class="detail-val" style="color:' + (pending > 0 ? '#B06000' : '#1E7B3C') + ';font-weight:600">' + (pending > 0 ? '$' + fmtMoney(pending) : '✓ Liquidado') + '</span></div>' +
    methodRowsHTML +
    '<div class="detail-row"><span class="detail-lbl">No. abonos</span><span class="detail-val">' + payments.length + '</span></div>' +

    '<div class="section-label mt16">Historial de abonos</div>' +
    paymentsHTML +

    '<div class="section-label mt16">Documentos (' + docsStatus.done + '/4)</div>' +
    docRows +
    '<div style="margin-top:10px">' + logHTML + '</div>' +

    (c.comments ? '<div class="section-label mt16">Comentarios</div><div style="font-size:13px;color:#555;padding:6px 0;">' + esc(c.comments) + '</div>' : '') +
    '<div class="section-label mt16">Datos del registro</div>' +
    '<div class="detail-row"><span class="detail-lbl">Fecha registro</span><span class="detail-val">' + formatDate(c.regDate) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Evento</span><span class="detail-val">' + esc(c.eventDate || '—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Registrado por</span><span class="detail-val">' + esc(c.createdBy || '—') + '</span></div>' +
    (c.beca ? '<div class="section-label mt16" style="color:#1E7B3C">🎓 Beca asignada</div>' +
      '<div class="detail-row"><span class="detail-lbl">Monto beca</span><span class="detail-val" style="color:#1E7B3C">$' + fmtMoney(c.beca.amount) + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Motivo</span><span class="detail-val">' + esc(c.beca.reason || '—') + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Asignada por</span><span class="detail-val">' + esc(c.beca.assignedBy || '—') + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Fecha</span><span class="detail-val">' + formatDate(c.beca.date) + '</span></div>' : '') +
    (c.penalizacion ? '<div class="section-label mt16" style="color:#B06000">⚠️ Penalización</div>' +
      '<div class="detail-row"><span class="detail-lbl">Monto</span><span class="detail-val" style="color:#B06000">$' + fmtMoney(c.penalizacion.amount) + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Motivo</span><span class="detail-val">' + esc(c.penalizacion.reason || '—') + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Notas</span><span class="detail-val">' + esc(c.penalizacion.notes || '—') + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Fecha</span><span class="detail-val">' + formatDate(c.penalizacion.date) + '</span></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;">' +
        '<button onclick="openEditPenalizacion()" style="flex:1;background:#FFF4E5;border:1.5px solid #B06000;color:#B06000;border-radius:10px;padding:8px;font-size:13px;cursor:pointer;">✏️ Editar</button>' +
        '<button onclick="deletePenalizacion()" style="flex:1;background:#FCEEF0;border:1.5px solid #C0392B;color:#C0392B;border-radius:10px;padding:8px;font-size:13px;cursor:pointer;">🗑 Eliminar</button>' +
      '</div>' : '') +
    (c.cancelacion ? '<div class="section-label mt16" style="color:#555">❌ Cancelación</div>' +
      '<div class="detail-row"><span class="detail-lbl">Tipo</span><span class="detail-val">' +
        (c.cancelacion.type === 'devolucion_total' ? '💰 Devolución total' :
         c.cancelacion.type === 'devolucion_parcial' ? '💸 Devolución parcial' : '🔄 Crédito siguiente evento') +
      '</span></div>' +
      (c.cancelacion.amount > 0 ? '<div class="detail-row"><span class="detail-lbl">Monto devuelto</span><span class="detail-val">$' + fmtMoney(c.cancelacion.amount) + '</span></div>' : '') +
      '<div class="detail-row"><span class="detail-lbl">Fecha</span><span class="detail-val">' + formatDate(c.cancelacion.date) + '</span></div>' +
      '<div class="detail-row"><span class="detail-lbl">Gestionó</span><span class="detail-val">' + esc(c.cancelacion.cancelBy || '—') + '</span></div>' +
      (c.cancelacion.notes ? '<div class="detail-row"><span class="detail-lbl">Notas</span><span class="detail-val">' + esc(c.cancelacion.notes) + '</span></div>' : '') : '');
}

// ===== VER DOCUMENTO =====
function viewDoc(coupleId, docKey) {
  const c = couples.find(x => x.id === coupleId);
  if (!c || !c.docs || !c.docs[docKey]) return;
  const doc = c.docs[docKey];
  const win = window.open('', '_blank');
  if (!win) { showToast('Permite ventanas emergentes para ver documentos', 'error'); return; }
  if (doc.data && doc.data.startsWith('data:image')) {
    win.document.write('<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="' + doc.data + '" style="max-width:100%;max-height:100vh;object-fit:contain;"></body>');
  } else {
    win.document.write('<iframe src="' + doc.data + '" style="width:100%;height:100vh;border:none;"></iframe>');
  }
}

// ===== DESCARGAR DOCUMENTO INDIVIDUAL =====
// Los documentos (acta, identificación, foto) solo viven como base64 en
// este dispositivo — nunca se suben a Sheets — así que la única forma de
// sacarlos de la app es descargándolos aquí. Genera el archivo con el
// nombre de la pareja para que sea fácil identificarlo al subirlo después
// a otro sistema (por ejemplo, la app de historial en Excel).
function downloadDoc(coupleId, docKey) {
  const c = couples.find(x => x.id === coupleId);
  if (!c || !c.docs || !c.docs[docKey]) return;
  const doc = c.docs[docKey];
  if (!doc.data) return;

  const labelMap = { acta: 'acta_matrimonio', idHim: 'identificacion_el', idHer: 'identificacion_ella', photo: 'foto_juntos' };
  const safeName = ((c.him || '') + '_' + (c.her || ''))
    .trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || c.id;

  // Intenta conservar la extensión original; si no hay nombre guardado,
  // la deduce del tipo de dato (data:image/jpeg;base64,... etc.)
  let ext = '';
  if (doc.name && doc.name.includes('.')) {
    ext = doc.name.split('.').pop().toLowerCase();
  } else {
    const mimeMatch = doc.data.match(/^data:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1] : '';
    ext = mime === 'image/png' ? 'png'
      : mime === 'application/pdf' ? 'pdf'
      : mime.startsWith('image/') ? mime.split('/')[1]
      : 'jpg';
  }

  const a = document.createElement('a');
  a.href = doc.data;
  a.download = safeName + '_' + (labelMap[docKey] || docKey) + '.' + ext;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ===== SUBIR DOCUMENTO INDIVIDUAL =====
let uploadingDocKey = null;
let uploadingCoupleId = null;

function openDocUpload(coupleId, docKey) {
  uploadingDocKey = docKey;
  uploadingCoupleId = coupleId;
  const labels = { acta: '📋 Acta de matrimonio', idHim: '🪪 Identificación de Él', idHer: '🪪 Identificación de Ella', photo: '📷 Foto juntos' };
  document.getElementById('doc-upload-label-text').textContent = labels[docKey];
  document.getElementById('single-doc-file').value = '';
  const preview = document.getElementById('single-doc-preview');
  preview.innerHTML = '';
  preview.classList.add('hidden');
  delete preview.dataset.data;
  delete preview.dataset.name;
  closeModal('modal-detail');
  document.getElementById('modal-doc-upload').classList.remove('hidden');
}

function handleSingleDocSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('El archivo es muy grande (máx 5MB)', 'error'); return; }
  const preview = document.getElementById('single-doc-preview');
  const reader = new FileReader();
  reader.onload = (e) => {
    if (file.type.startsWith('image/')) {
      preview.innerHTML = '<img src="' + e.target.result + '" style="max-width:100%;border-radius:8px;margin-top:8px;">';
    } else {
      preview.innerHTML = '<div style="padding:12px;background:#F0F4FF;border-radius:8px;margin-top:8px;font-size:13px;color:#1B5FA8;">📄 ' + esc(file.name) + '<br><span style="font-size:11px;color:#888">' + (file.size/1024).toFixed(0) + ' KB</span></div>';
    }
    preview.classList.remove('hidden');
    preview.dataset.data = e.target.result;
    preview.dataset.name = file.name;
  };
  reader.readAsDataURL(file);
}

function saveSingleDoc() {
  const preview = document.getElementById('single-doc-preview');
  if (!preview.dataset.data) { showToast('Selecciona un archivo primero', 'error'); return; }
  const idx = couples.findIndex(c => c.id === uploadingCoupleId);
  if (idx === -1) return;
  if (!couples[idx].docs) couples[idx].docs = {};
  couples[idx].docs[uploadingDocKey] = { name: preview.dataset.name, data: preview.dataset.data };
  if (!couples[idx].docLog) couples[idx].docLog = [];
  const docNames = { acta: 'acta de matrimonio', idHim: 'identificación de él', idHer: 'identificación de ella', photo: 'foto juntos' };
  couples[idx].docLog.push({ ts: new Date().toISOString().split('T')[0], user: currentUser.name, doc: docNames[uploadingDocKey] });
  saveToStorage();
  closeModal('modal-doc-upload');
  showToast('Documento guardado ✓', 'success');
  setTimeout(() => openDetail(uploadingCoupleId), 200);
  renderDocuments();
}

// ===== MODAL DE PAGO =====
function openEditPaymentModal(coupleId, paymentId) {
  const c = couples.find(x => x.id === coupleId);
  if (!c) return;
  const p = (c.payments || []).find(x => x.id === paymentId);
  if (!p) return;
  detailCoupleId = coupleId;

  document.getElementById('edit-pay-couple-id').value = coupleId;
  document.getElementById('edit-pay-id').value = paymentId;
  document.getElementById('edit-pay-amount').value = p.amount;
  document.getElementById('edit-pay-date').value = p.date;
  document.getElementById('edit-pay-method').value = p.method || 'efectivo';
  document.getElementById('edit-pay-received-by').value = p.receivedBy || '';
  document.getElementById('edit-pay-note').value = p.note || '';
  closeModal('modal-detail');
  document.getElementById('modal-edit-payment').classList.remove('hidden');
}

function saveEditPayment() {
  const coupleId = document.getElementById('edit-pay-couple-id').value;
  const paymentId = document.getElementById('edit-pay-id').value;
  const amount = parseFloat(document.getElementById('edit-pay-amount').value);
  const date = document.getElementById('edit-pay-date').value;
  const method = document.getElementById('edit-pay-method').value;
  const receivedBy = document.getElementById('edit-pay-received-by').value.trim();
  const note = document.getElementById('edit-pay-note').value.trim();

  if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
  if (!date) { showToast('Selecciona la fecha', 'error'); return; }
  if (!receivedBy) { showToast('Indica quién recibió el pago', 'error'); return; }

  const cIdx = couples.findIndex(c => c.id === coupleId);
  if (cIdx === -1) return;
  const pIdx = couples[cIdx].payments.findIndex(p => p.id === paymentId);
  if (pIdx === -1) return;

  couples[cIdx].payments[pIdx] = {
    ...couples[cIdx].payments[pIdx],
    amount, date, method, receivedBy, note,
    editedBy: currentUser.name,
    editedAt: new Date().toISOString(),
  };
  couples[cIdx].amount = couples[cIdx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  saveToStorage();
  closeModal('modal-edit-payment');
  setTimeout(() => { openDetail(coupleId); showToast('Abono actualizado ✓', 'success'); }, 200);
  refreshDashboard();
  renderCouples();
  renderPayments();
}

function openPaymentModal() {
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  const cost = config.cost || 0;
  const totalPaid = getTotalPaid(c);
  const pending = Math.max(0, cost - totalPaid);
  document.getElementById('pay-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Pendiente</span><span class="pi-val amber">$' + fmtMoney(pending) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Abonos anteriores</span><span class="pi-val">' + (c.payments || []).length + '</span></div>';
  document.getElementById('pay-amount').value = pending > 0 ? pending.toFixed(2) : '';
  document.getElementById('pay-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('pay-received-by').value = '';
  document.getElementById('pay-method').value = 'efectivo';
  document.getElementById('pay-note').value = '';
  document.getElementById('pay-preview').classList.remove('visible');
  closeModal('modal-detail');
  document.getElementById('modal-payment').classList.remove('hidden');
}

function updatePaymentPreview() {
  const amount = parseFloat(document.getElementById('pay-amount').value) || 0;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c || amount <= 0) { document.getElementById('pay-preview').classList.remove('visible'); return; }
  const cost = config.cost || 0;
  const newTotal = getTotalPaid(c) + amount;
  const newPending = Math.max(0, cost - newTotal);
  const preview = document.getElementById('pay-preview');
  preview.innerHTML = 'Nuevo total: <strong>$' + fmtMoney(newTotal) + '</strong> · Pendiente: <strong>$' + fmtMoney(newPending) + '</strong>' + (newPending <= 0 ? ' ✓ ¡Liquidado!' : '');
  preview.classList.add('visible');
}

function savePayment() {
  const amount = parseFloat(document.getElementById('pay-amount').value);
  if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
  const date = document.getElementById('pay-date').value;
  const receivedBy = document.getElementById('pay-received-by').value.trim();
  const method = document.getElementById('pay-method').value;
  const note = document.getElementById('pay-note').value.trim();
  if (!date) { showToast('Selecciona la fecha del pago', 'error'); return; }
  if (!receivedBy) { showToast('Indica quién recibió el pago', 'error'); return; }
  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;
  if (!couples[idx].payments) couples[idx].payments = [];
  const payment = {
    id: 'P' + Date.now(),
    coupleId: detailCoupleId,
    amount, date, receivedBy, method, note,
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };
  couples[idx].payments.push(payment);
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  saveToStorage();
  autoSyncCouple(couples[idx]); // Enviar a Sheets automáticamente
  closeModal('modal-payment');
  setTimeout(() => { openDetail(detailCoupleId); showToast('Abono registrado ✓', 'success'); }, 200);
  refreshDashboard();
  renderCouples();
  renderPayments();
}

// ===== BECAS / FONDO =====
function getFund() {
  return JSON.parse(localStorage.getItem('rm_fund') || '{"movements":[]}');
}
function saveFund(fund) {
  localStorage.setItem('rm_fund', JSON.stringify(fund));
}
function getFundBalance() {
  const fund = getFund();
  return fund.movements.reduce((s, m) => m.type === 'out' ? s - m.amount : s + m.amount, 0);
}

function renderBecas() {
  const fund = getFund();
  const totalIn = fund.movements.filter(m => m.type === 'in').reduce((s, m) => s + m.amount, 0);
  const totalOut = fund.movements.filter(m => m.type === 'out').reduce((s, m) => s + m.amount, 0);
  const balance = totalIn - totalOut;

  document.getElementById('fund-balance').textContent = '$' + fmtMoney(balance);
  document.getElementById('fund-in').textContent = '$' + fmtMoney(totalIn);
  document.getElementById('fund-out').textContent = '$' + fmtMoney(totalOut);
  document.getElementById('fund-date').value = new Date().toISOString().split('T')[0];

  // Movimientos
  const movEl = document.getElementById('fund-movements');
  if (fund.movements.length === 0) {
    movEl.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin movimientos aún.</div>';
  } else {
    const sorted = [...fund.movements].sort((a, b) => new Date(b.date) - new Date(a.date));
    movEl.innerHTML = sorted.map(m => {
      const isIn = m.type === 'in';
      const icons = { donacion: '🎁', penalizacion: '💸', beca: '🎓' };
      const icon = icons[m.subtype] || (isIn ? '💰' : '🎓');
      return '<div class="fund-movement-item">' +
        '<div class="fund-movement-icon">' + icon + '</div>' +
        '<div class="fund-movement-info">' +
          '<div class="fund-movement-desc">' + esc(m.description) + '</div>' +
          '<div class="fund-movement-meta">' + formatDate(m.date) + ' · ' + esc(m.registeredBy || '') + '</div>' +
        '</div>' +
        '<div class="fund-movement-amt ' + (isIn ? 'in' : 'out') + '">' + (isIn ? '+' : '−') + '$' + fmtMoney(m.amount) + '</div>' +
      '</div>';
    }).join('');
  }

  // Parejas becadas
  const scholarsEl = document.getElementById('fund-scholars');
  const becadas = couples.filter(c => c.beca);
  if (becadas.length === 0) {
    scholarsEl.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin becas asignadas aún.</div>';
  } else {
    scholarsEl.innerHTML = becadas.map(c =>
      '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
        '<div class="couple-avatar" style="background:#EAF7EE;color:#1E7B3C;font-size:18px">🎓</div>' +
        '<div class="couple-info">' +
          '<div class="couple-names">' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
          '<div class="couple-meta">Beca: $' + fmtMoney(c.beca.amount) + ' · ' + esc(c.beca.reason || '') + '</div>' +
        '</div>' +
        '<span class="badge badge-becada">Becada</span>' +
      '</div>'
    ).join('');
  }
}

function addFundMovement() {
  const type = document.getElementById('fund-type').value;
  const amount = parseFloat(document.getElementById('fund-amount').value);
  const origin = document.getElementById('fund-origin').value.trim();
  const date = document.getElementById('fund-date').value;
  if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
  if (!origin) { showToast('Ingresa el origen o descripción', 'error'); return; }
  if (!date) { showToast('Selecciona la fecha', 'error'); return; }
  const fund = getFund();
  fund.movements.push({
    id: 'F' + Date.now(),
    type: 'in',
    subtype: type,
    amount, date,
    description: (type === 'penalizacion' ? '💸 Penalización: ' : '🎁 Donación: ') + origin,
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  });
  saveFund(fund);
  document.getElementById('fund-amount').value = '';
  document.getElementById('fund-origin').value = '';
  renderBecas();
  showToast('Movimiento registrado ✓', 'success');
}

// ===== MODAL BECA =====
function openBecaModal() {
  if (!requireAdmin()) return;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  const cost = config.cost || 0;
  const totalPaid = getTotalPaid(c);
  const faltante = Math.max(0, cost - totalPaid);
  const balance = getFundBalance();
  document.getElementById('beca-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Faltante</span><span class="pi-val amber">$' + fmtMoney(faltante) + '</span></div>';
  document.getElementById('beca-fund-banner').textContent = 'Saldo disponible en fondo: $' + fmtMoney(balance);
  document.getElementById('beca-amount').value = faltante > 0 ? faltante.toFixed(2) : '';
  document.getElementById('beca-reason').value = '';
  closeModal('modal-detail');
  document.getElementById('modal-beca').classList.remove('hidden');
}

function saveBeca() {
  if (!requireAdmin()) return;
  const amount = parseFloat(document.getElementById('beca-amount').value);
  const reason = document.getElementById('beca-reason').value.trim();
  if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
  const balance = getFundBalance();
  if (amount > balance) { showToast('Saldo insuficiente en el fondo ($' + fmtMoney(balance) + ')', 'error'); return; }
  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;
  const c = couples[idx];

  // Registrar beca en la pareja
  const becaPayment = {
    id: 'B' + Date.now(),
    coupleId: detailCoupleId,
    amount, date: new Date().toISOString().split('T')[0],
    receivedBy: 'Fondo REMA',
    method: 'beca',
    note: '🎓 Beca REMA' + (reason ? ': ' + reason : ''),
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };
  if (!couples[idx].payments) couples[idx].payments = [];
  couples[idx].payments.push(becaPayment);
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  couples[idx].beca = { amount, reason, date: becaPayment.date, assignedBy: currentUser.name };
  saveToStorage();
  autoSyncCouple(couples[idx]); // Enviar a Sheets automáticamente

  // Registrar salida del fondo
  const fund = getFund();
  fund.movements.push({
    id: 'FO' + Date.now(),
    type: 'out',
    subtype: 'beca',
    amount, date: becaPayment.date,
    description: '🎓 Beca: ' + c.him + ' & ' + c.her + (reason ? ' — ' + reason : ''),
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  });
  saveFund(fund);
  closeModal('modal-beca');
  setTimeout(() => { openDetail(detailCoupleId); showToast('Beca asignada ✓', 'success'); }, 200);
  refreshDashboard(); renderCouples();
}

// ===== MODAL PENALIZACIÓN =====
function openEditPenalizacion() {
  if (!requireAdmin()) return;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c || !c.penalizacion) return;
  const totalPaid = getTotalPaid(c);
  const excedente = totalPaid - (config.cost || 0);

  document.getElementById('pen-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Penalización actual</span><span class="pi-val amber">$' + fmtMoney(c.penalizacion.amount) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado actual</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>';

  document.getElementById('pen-amount').value = c.penalizacion.amount;
  document.getElementById('pen-reason').value = c.penalizacion.reason || 'No se presentó al evento';
  document.getElementById('pen-notes').value = c.penalizacion.notes || '';
  document.getElementById('pen-date').value = c.penalizacion.date || new Date().toISOString().split('T')[0];
  closeModal('modal-detail');
  document.getElementById('modal-penalizacion').classList.remove('hidden');

  // Cambiar el botón guardar para que actualice en vez de crear
  document.querySelector('#modal-penalizacion .btn-primary').onclick = saveEditPenalizacion;
  document.querySelector('#modal-penalizacion .modal-header h3').textContent = '✏️ Editar penalización';
}

function saveEditPenalizacion() {
  if (!requireAdmin()) return;
  const amount = parseFloat(document.getElementById('pen-amount').value);
  const reason = document.getElementById('pen-reason').value;
  const notes = document.getElementById('pen-notes').value.trim();
  const date = document.getElementById('pen-date').value;
  if (!amount || amount <= 0) { showToast('Ingresa el monto', 'error'); return; }

  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;

  // Eliminar el pago negativo anterior
  couples[idx].payments = (couples[idx].payments || []).filter(p => p.method !== 'penalizacion');

  // Agregar el nuevo pago negativo
  couples[idx].payments.push({
    id: 'PEN_' + Date.now(),
    coupleId: detailCoupleId,
    amount: -amount,
    date,
    receivedBy: 'Sistema REMA',
    method: 'penalizacion',
    note: '⚠️ Penalización: ' + reason + (notes ? ' — ' + notes : ''),
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  });

  // Actualizar metadatos
  couples[idx].penalizacion = { amount, reason, notes, date, registeredBy: currentUser.name, registeredAt: new Date().toISOString() };
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);

  // Actualizar fondo — ajustar diferencia
  saveToStorage();
  autoSyncCouple(couples[idx]); // Enviar a Sheets automáticamente
  closeModal('modal-penalizacion');

  // Restaurar botón original
  document.querySelector('#modal-penalizacion .btn-primary').onclick = savePenalizacion;
  document.querySelector('#modal-penalizacion .modal-header h3').textContent = '⚠️ Registrar penalización';

  setTimeout(() => { openDetail(detailCoupleId); showToast('Penalización actualizada ✓', 'success'); }, 200);
  refreshDashboard(); renderCouples();
}

function deletePenalizacion() {
  if (!requireAdmin()) return;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c || !c.penalizacion) return;
  if (!confirm('¿Eliminar la penalización de $' + fmtMoney(c.penalizacion.amount) + '?\n\nEl monto volverá al total pagado de la pareja.')) return;

  const idx = couples.findIndex(x => x.id === detailCoupleId);
  // Eliminar el pago negativo del historial
  couples[idx].payments = (couples[idx].payments || []).filter(p => p.method !== 'penalizacion');
  // Eliminar metadatos
  delete couples[idx].penalizacion;
  // Recalcular total
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);

  saveToStorage();
  autoSyncCouple(couples[idx], { clearPenalizacion: true }); // Enviar a Sheets automáticamente (limpia la columna Penalización allá)
  closeModal('modal-detail');
  setTimeout(() => { openDetail(detailCoupleId); showToast('Penalización eliminada ✓', ''); }, 200);
  refreshDashboard(); renderCouples();
}

function openPenalizacionModal() {
  if (!requireAdmin()) return;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  const totalPaid = getTotalPaid(c);
  const cost = config.cost || 0;
  const excedente = totalPaid - cost;

  document.getElementById('pen-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>' +
    (excedente > 0
      ? '<div class="pi-row"><span class="pi-lbl">Excedente sobre costo</span><span class="pi-val amber">$' + fmtMoney(excedente) + '</span></div>'
      : '') +
    '<div class="pi-row"><span class="pi-lbl">El monto penalizado irá al fondo de becas</span></div>';

  // Sugerir el excedente como monto de penalización si aplica
  document.getElementById('pen-amount').value = excedente > 0 ? excedente.toFixed(2) : '';
  document.getElementById('pen-reason').value = 'No se presentó al evento';
  document.getElementById('pen-notes').value = '';
  document.getElementById('pen-date').value = new Date().toISOString().split('T')[0];
  closeModal('modal-detail');
  document.getElementById('modal-penalizacion').classList.remove('hidden');
}

function savePenalizacion() {
  if (!requireAdmin()) return;
  const amount = parseFloat(document.getElementById('pen-amount').value);
  const reason = document.getElementById('pen-reason').value;
  const notes = document.getElementById('pen-notes').value.trim();
  const date = document.getElementById('pen-date').value;
  if (!amount || amount <= 0) { showToast('Ingresa el monto de penalización', 'error'); return; }
  if (!date) { showToast('Selecciona la fecha', 'error'); return; }

  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;
  const c = couples[idx];
  const totalPaid = getTotalPaid(c);

  if (amount > totalPaid) {
    showToast('La penalización no puede ser mayor al total pagado ($' + fmtMoney(totalPaid) + ')', 'error');
    return;
  }

  // Registrar penalización como abono negativo en el historial
  const penPayment = {
    id: 'PEN' + Date.now(),
    coupleId: detailCoupleId,
    amount: -amount, // negativo para descontar
    date,
    receivedBy: 'Sistema REMA',
    method: 'penalizacion',
    note: '⚠️ Penalización: ' + reason + (notes ? ' — ' + notes : ''),
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };
  if (!couples[idx].payments) couples[idx].payments = [];
  couples[idx].payments.push(penPayment);
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);

  // Marcar pareja como penalizada
  couples[idx].penalizacion = {
    amount, reason, notes, date,
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };
  saveToStorage();
  autoSyncCouple(couples[idx]); // Enviar a Sheets automáticamente

  // Agregar al fondo como entrada
  const fund = getFund();
  fund.movements.push({
    id: 'FP' + Date.now(),
    type: 'in',
    subtype: 'penalizacion',
    amount, date,
    description: '💸 Penalización: ' + c.him + ' & ' + c.her + ' — ' + reason + (notes ? ' (' + notes + ')' : ''),
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  });
  saveFund(fund);

  closeModal('modal-penalizacion');
  setTimeout(() => {
    openDetail(detailCoupleId);
    const nuevoTotal = getTotalPaid(couples[idx]);
    const costo = config.cost || 0;
    const excedente = nuevoTotal - costo;
    let msg = 'Penalización de $' + fmtMoney(amount) + ' registrada ✓';
    if (excedente > 0) msg += ' · Excedente: $' + fmtMoney(excedente);
    showToast(msg, 'success');
  }, 200);
  refreshDashboard();
  renderCouples();
}

// ===== CANCELACIÓN =====
function openCancelacionModal() {
  if (!requireAdmin()) return;
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  const totalPaid = getTotalPaid(c);

  document.getElementById('cancel-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Cancelación con anticipación</span></div>';

  document.getElementById('cancel-type').value = 'devolucion_total';
  document.getElementById('cancel-amount').value = totalPaid.toFixed(2);
  document.getElementById('cancel-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('cancel-by').value = '';
  document.getElementById('cancel-notes').value = '';
  updateCancelForm();
  closeModal('modal-detail');
  document.getElementById('modal-cancelacion').classList.remove('hidden');
}

function updateCancelForm() {
  const type = document.getElementById('cancel-type').value;
  const amountSection = document.getElementById('cancel-amount-section');
  const creditoSection = document.getElementById('cancel-credito-section');
  const c = couples.find(x => x.id === detailCoupleId);
  const totalPaid = c ? getTotalPaid(c) : 0;

  if (type === 'devolucion_total') {
    amountSection.classList.remove('hidden');
    creditoSection.classList.add('hidden');
    document.getElementById('cancel-amount').value = totalPaid.toFixed(2);
    document.getElementById('cancel-amount').readOnly = true;
  } else if (type === 'devolucion_parcial') {
    amountSection.classList.remove('hidden');
    creditoSection.classList.add('hidden');
    document.getElementById('cancel-amount').value = '';
    document.getElementById('cancel-amount').readOnly = false;
  } else {
    amountSection.classList.add('hidden');
    creditoSection.classList.remove('hidden');
  }
}

function saveCancelacion() {
  if (!requireAdmin()) return;
  const type = document.getElementById('cancel-type').value;
  const date = document.getElementById('cancel-date').value;
  const cancelBy = document.getElementById('cancel-by').value.trim();
  const notes = document.getElementById('cancel-notes').value.trim();

  if (!date) { showToast('Selecciona la fecha', 'error'); return; }
  if (!cancelBy) { showToast('Indica quién gestionó la cancelación', 'error'); return; }

  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;
  const c = couples[idx];
  const totalPaid = getTotalPaid(c);

  let amount = 0;
  let historyNote = '';
  let toastMsg = '';

  if (type === 'devolucion_total') {
    amount = totalPaid;
    historyNote = '❌ Cancelación — Devolución total de $' + fmtMoney(amount) + '. Gestionó: ' + cancelBy + (notes ? '. ' + notes : '');
    toastMsg = 'Cancelación con devolución total de $' + fmtMoney(amount) + ' ✓';
  } else if (type === 'devolucion_parcial') {
    amount = parseFloat(document.getElementById('cancel-amount').value);
    if (!amount || amount <= 0) { showToast('Ingresa el monto a devolver', 'error'); return; }
    if (amount > totalPaid) { showToast('No puede ser mayor al total pagado', 'error'); return; }
    historyNote = '❌ Cancelación — Devolución parcial de $' + fmtMoney(amount) + ' de $' + fmtMoney(totalPaid) + ' pagados. Gestionó: ' + cancelBy + (notes ? '. ' + notes : '');
    toastMsg = 'Cancelación con devolución parcial de $' + fmtMoney(amount) + ' ✓';
  } else {
    // Crédito — no se mueve dinero
    historyNote = '🔄 Cancelación — Crédito para siguiente evento por $' + fmtMoney(totalPaid) + '. Gestionó: ' + cancelBy + (notes ? '. ' + notes : '');
    toastMsg = 'Cancelación con crédito para siguiente evento ✓';
  }

  // Agregar al historial de abonos como movimiento negativo (devolución)
  if (amount > 0) {
    const cancelPayment = {
      id: 'CAN' + Date.now(),
      coupleId: detailCoupleId,
      amount: -amount,
      date,
      receivedBy: cancelBy,
      method: 'cancelacion',
      note: historyNote,
      registeredBy: currentUser.name,
      registeredAt: new Date().toISOString(),
    };
    if (!couples[idx].payments) couples[idx].payments = [];
    couples[idx].payments.push(cancelPayment);
    couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  }

  // Marcar como cancelada y actualizar comentarios
  couples[idx].cancelacion = {
    type, amount, date, cancelBy, notes,
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };

  // Agregar a comentarios
  const prevComments = couples[idx].comments || '';
  const cancelComment = '[' + formatDate(date) + '] ' + historyNote;
  couples[idx].comments = prevComments ? prevComments + '\n' + cancelComment : cancelComment;

  saveToStorage();
  autoSyncCouple(couples[idx]); // Enviar a Sheets automáticamente
  closeModal('modal-cancelacion');
  setTimeout(() => { openDetail(detailCoupleId); showToast(toastMsg, 'success'); }, 200);
  refreshDashboard();
  renderCouples();
}

function deleteCouple() {
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;

  // Mostrar modal de confirmación
  const totalPaid = getTotalPaid(c);
  document.getElementById('delete-confirm-name').textContent = c.him + ' & ' + c.her;
  document.getElementById('delete-confirm-detail').textContent =
    c.payments.length + ' abono(s) · $' + fmtMoney(totalPaid) + ' pagado';
  document.getElementById('modal-delete-confirm').classList.remove('hidden');
}

function confirmDeleteCouple() {
  couples = couples.filter(x => x.id !== detailCoupleId);
  saveToStorage();
  closeModal('modal-delete-confirm');
  closeModal('modal-detail');
  showToast('Registro eliminado', '');
  refreshDashboard();
  renderCouples();
  renderPayments();
  renderDocuments();
}

function deletePayment(coupleId, paymentId) {
  if (!confirm('¿Eliminar este abono? Esta acción no se puede deshacer.')) return;
  const idx = couples.findIndex(c => c.id === coupleId);
  if (idx === -1) return;
  couples[idx].payments = (couples[idx].payments || []).filter(p => p.id !== paymentId);
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  saveToStorage();
  renderDetailModal(couples[idx]);
  refreshDashboard();
  renderCouples();
  showToast('Abono eliminado', '');
}

// ===== NUEVA / EDITAR PAREJA =====
function openNewCoupleModal(coupleIdToEdit) {
  editingCoupleId = coupleIdToEdit || null;
  docData = { acta: null, idHim: null, idHer: null, photo: null };
  ['cp-him','cp-her','cp-tel-him','cp-tel-her','cp-email-him','cp-email-her','cp-amount','cp-received-by','cp-comments'].forEach(f => {
    const el = document.getElementById(f);
    if (el) el.value = '';
  });
  const methodEl = document.getElementById('cp-method');
  if (methodEl) methodEl.value = 'efectivo';
  ['acta','idHim','idHer','photo'].forEach(k => {
    document.getElementById('status-' + k).textContent = 'Sin cargar';
    document.getElementById('status-' + k).classList.remove('loaded');
    document.getElementById('icon-' + k).style.opacity = '1';
    const uploadEl = document.getElementById('doc-' + k).closest('.doc-upload-item');
    if (uploadEl) uploadEl.classList.remove('has-doc');
  });
  const dateRange = [config.dateStart, config.dateEnd].filter(Boolean).map(formatDate).join(' – ');
  document.getElementById('cp-event-date').value = dateRange || 'Sin configurar';
  document.getElementById('cp-reg-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-cost').textContent = '$' + fmtMoney(config.cost || 0);
  document.getElementById('modal-pending').textContent = '$' + fmtMoney(config.cost || 0);

  if (coupleIdToEdit) {
    const c = couples.find(x => x.id === coupleIdToEdit);
    if (c) {
      document.getElementById('cp-him').value = c.him || '';
      document.getElementById('cp-her').value = c.her || '';
      document.getElementById('cp-tel-him').value = c.telHim || '';
      document.getElementById('cp-tel-her').value = c.telHer || '';
      document.getElementById('cp-email-him').value = c.emailHim || '';
      document.getElementById('cp-email-her').value = c.emailHer || '';
      document.getElementById('cp-comments').value = c.comments || '';
      document.getElementById('cp-reg-date').value = c.regDate || '';
      document.getElementById('pay-section').style.display = 'none';
      if (c.docs) {
        ['acta','idHim','idHer','photo'].forEach(k => {
          if (c.docs[k]) {
            document.getElementById('status-' + k).textContent = 'Cargado ✓';
            document.getElementById('status-' + k).classList.add('loaded');
            document.getElementById('doc-' + k).closest('.doc-upload-item').classList.add('has-doc');
            docData[k] = c.docs[k];
          }
        });
      }
    }
    document.getElementById('modal-couple-title').textContent = 'Editar registro';
  } else {
    document.getElementById('pay-section').style.display = 'block';
    document.getElementById('modal-couple-title').textContent = 'Nueva pareja';
  }
  document.getElementById('modal-couple').classList.remove('hidden');
}

function editCouple() {
  closeModal('modal-detail');
  setTimeout(() => openNewCoupleModal(detailCoupleId), 100);
}

function updatePaymentStatus() {
  const amount = parseFloat(document.getElementById('cp-amount').value) || 0;
  document.getElementById('modal-pending').textContent = '$' + fmtMoney(Math.max(0, (config.cost || 0) - amount));
}

function triggerUpload(inputId) { document.getElementById(inputId).click(); }

function handleDocUpload(type, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('Archivo muy grande (máx 5MB)', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    docData[type] = { name: file.name, data: e.target.result };
    document.getElementById('status-' + type).textContent = 'Cargado ✓';
    document.getElementById('status-' + type).classList.add('loaded');
    input.closest('.doc-upload-item').classList.add('has-doc');
  };
  reader.readAsDataURL(file);
}

function saveCouple() {
  const him = document.getElementById('cp-him').value.trim();
  const her = document.getElementById('cp-her').value.trim();
  if (!him || !her) { showToast('Ingresa los nombres de ambos', 'error'); return; }
  const btn = document.getElementById('btn-save-couple');
  btn.disabled = true; btn.textContent = 'Guardando...';
  const now = new Date().toISOString();
  const nowDisplay = now.split('T')[0];
  let couple;
  if (editingCoupleId) {
    const idx = couples.findIndex(c => c.id === editingCoupleId);
    couple = { ...couples[idx] };
    const docLog = couple.docLog || [];
    ['acta','idHim','idHer','photo'].forEach(k => {
      if (docData[k] && docData[k].data && (!couple.docs || !couple.docs[k])) {
        docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta:'acta de matrimonio', idHim:'identificación de él', idHer:'identificación de ella', photo:'foto juntos' }[k] });
      }
    });
    couple.docLog = docLog;
    couple.him = him; couple.her = her;
    couple.telHim = document.getElementById('cp-tel-him').value.trim();
    couple.telHer = document.getElementById('cp-tel-her').value.trim();
    couple.emailHim = document.getElementById('cp-email-him').value.trim();
    couple.emailHer = document.getElementById('cp-email-her').value.trim();
    couple.comments = document.getElementById('cp-comments').value.trim();
    couple.regDate = document.getElementById('cp-reg-date').value;
    if (!couple.docs) couple.docs = {};
    ['acta','idHim','idHer','photo'].forEach(k => { if (docData[k] && docData[k].data) couple.docs[k] = docData[k]; });
    couples[idx] = couple;
  } else {
    const docLog = [];
    ['acta','idHim','idHer','photo'].forEach(k => {
      if (docData[k] && docData[k].data) docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta:'acta de matrimonio', idHim:'identificación de él', idHer:'identificación de ella', photo:'foto juntos' }[k] });
    });
    const initialAmount = parseFloat(document.getElementById('cp-amount').value) || 0;
    const initialReceiver = document.getElementById('cp-received-by').value.trim();
    const initialMethod = document.getElementById('cp-method') ? document.getElementById('cp-method').value : 'efectivo';
    const initialPayments = [];
    if (initialAmount > 0 && initialReceiver) {
      initialPayments.push({
        id: 'P' + Date.now(),
        coupleId: 'TMP',
        amount: initialAmount,
        date: document.getElementById('cp-reg-date').value,
        receivedBy: initialReceiver,
        method: initialMethod,
        note: 'Pago inicial',
        registeredBy: currentUser.name,
        registeredAt: now,
      });
    }
    couple = {
      id: 'C' + Date.now(), him, her,
      telHim: document.getElementById('cp-tel-him').value.trim(),
      telHer: document.getElementById('cp-tel-her').value.trim(),
      emailHim: document.getElementById('cp-email-him').value.trim(),
      emailHer: document.getElementById('cp-email-her').value.trim(),
      amount: initialAmount,
      payments: initialPayments,
      comments: document.getElementById('cp-comments').value.trim(),
      regDate: document.getElementById('cp-reg-date').value,
      eventDate: document.getElementById('cp-event-date').value,
      docs: { acta: docData.acta, idHim: docData.idHim, idHer: docData.idHer, photo: docData.photo },
      docLog, createdBy: currentUser.name, createdAt: now,
    };
    if (couple.payments.length > 0) couple.payments[0].coupleId = couple.id;
    couples.unshift(couple);
  }
  saveToStorage();
  autoSyncCouple(couple); // Enviar a Sheets automáticamente
  btn.disabled = false; btn.textContent = 'Guardar registro';
  closeModal('modal-couple');
  showToast(editingCoupleId ? 'Registro actualizado ✓' : 'Pareja registrada ✓', 'success');
  refreshDashboard(); renderCouples();
}

// ===== USERS =====
function renderUsers() {
  document.getElementById('users-list').innerHTML = users.map(u => {
    const roleLabel = u.role === 'admin' ? 'Admin' : u.role === 'registrador_principal' ? 'Reg. Principal' : 'Registrador';
    const roleBadge = u.role === 'admin' ? 'badge-admin' : u.role === 'registrador_principal' ? 'badge-reg-principal' : 'badge-reg';
    return '<div class="user-item">' +
      '<div class="user-avatar">' + esc(u.name.charAt(0).toUpperCase()) + '</div>' +
      '<div class="user-item-info"><div class="user-item-name">' + esc(u.name) + '</div><div class="user-item-email">' + esc(u.email) + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span class="badge ' + roleBadge + '">' + roleLabel + '</span>' +
        '<button onclick="openEditUserModal(' + u.id + ')" style="background:#F0E8E5;border:none;border-radius:8px;padding:6px 10px;font-size:12px;color:#7C2D3E;cursor:pointer;">✏️</button>' +
        '<button onclick="deleteUser(' + u.id + ')" style="background:#FCEEF0;border:none;border-radius:8px;padding:6px 10px;font-size:12px;color:#C0392B;cursor:pointer;">🗑</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openNewUserModal() {
  ['u-name','u-email','u-pass'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('u-role').value = 'registrador';
  document.getElementById('u-id').value = '';
  document.getElementById('u-pass-hint').textContent = 'Mínimo 6 caracteres';
  document.getElementById('modal-user-title').textContent = 'Agregar usuario';
  document.getElementById('modal-user').classList.remove('hidden');
}

function openEditUserModal(userId) {
  const u = users.find(x => x.id === userId);
  if (!u) return;
  document.getElementById('u-id').value = u.id;
  document.getElementById('u-name').value = u.name;
  document.getElementById('u-email').value = u.email;
  document.getElementById('u-pass').value = '';
  document.getElementById('u-role').value = u.role;
  document.getElementById('u-pass-hint').textContent = 'Déjala en blanco para no cambiarla';
  document.getElementById('modal-user-title').textContent = 'Editar usuario';
  document.getElementById('modal-user').classList.remove('hidden');
}

function deleteUser(userId) {
  const u = users.find(x => x.id === userId);
  if (!u) return;
  if (u.email === currentUser.email) { showToast('No puedes eliminarte a ti mismo', 'error'); return; }
  if (!confirm('¿Eliminar al usuario ' + u.name + '?')) return;
  users = users.filter(x => x.id !== userId);
  saveUsers();
  pushUsersToServer();
  renderUsers();
  showToast('Usuario eliminado', '');
}

// Envía la lista completa de usuarios (con contraseña) a la hoja Usuarios,
// para que cualquier otro dispositivo que abra el enlace ya pueda
// descargarla y entrar con la cuenta que se acaba de crear/editar/borrar.
async function pushUsersToServer() {
  if (!config.scriptUrl) return;
  try {
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'syncUsers', users })
    });
  } catch (e) { console.warn('No se pudo sincronizar usuarios al servidor:', e); }
}

function saveUser() {
  const id = document.getElementById('u-id').value;
  const name = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const pass = document.getElementById('u-pass').value;
  const role = document.getElementById('u-role').value;
  if (!name || !email) { showToast('Completa nombre y usuario', 'error'); return; }

  if (id) {
    // Editar usuario existente
    const idx = users.findIndex(u => u.id == id);
    if (idx === -1) return;
    // Verificar email único (excepto el mismo usuario)
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.id != id)) {
      showToast('Ya existe un usuario con ese correo', 'error'); return;
    }
    if (pass && pass.length < 6) { showToast('Contraseña mínimo 6 caracteres', 'error'); return; }
    users[idx].name = name;
    users[idx].email = email;
    users[idx].role = role;
    if (pass) users[idx].password = pass;
    // Si editamos el usuario actual, actualizar sesión
    if (users[idx].id === currentUser.id) {
      currentUser = { ...users[idx] };
      sessionStorage.setItem('rm_session', JSON.stringify(currentUser));
      document.getElementById('nav-avatar').textContent = currentUser.name.charAt(0).toUpperCase();
      document.getElementById('nav-username').textContent = currentUser.name;
    }
    showToast('Usuario actualizado ✓', 'success');
  } else {
    // Nuevo usuario
    if (!pass) { showToast('Ingresa una contraseña', 'error'); return; }
    if (pass.length < 6) { showToast('Contraseña mínimo 6 caracteres', 'error'); return; }
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
      showToast('Ya existe ese usuario', 'error'); return;
    }
    users.push({ id: Date.now(), name, email, password: pass, role });
    showToast('Usuario agregado ✓', 'success');
  }
  saveUsers();
  pushUsersToServer();
  renderUsers();
  closeModal('modal-user');
}

// ===== SINCRONIZACIÓN AUTOMÁTICA AL GUARDAR =====
// opts.clearPenalizacion: true SOLO cuando esta llamada viene de borrar
// una penalización explícitamente (deletePenalizacion). Es necesario
// distinguir "el usuario la borró" de "este dispositivo nunca se enteró
// de que existía" — si no, un dispositivo que no conoce una beca o
// penalización que otro registrador asignó podría, sin querer, mandar
// null y borrarla en Sheets en su próxima sincronización por cualquier
// otro motivo (p. ej. un abono nuevo). El servidor solo borra la
// columna Penalización cuando ve esta bandera explícita; de lo
// contrario, si no viene un valor, deja la celda como está.
async function autoSyncCouple(couple, opts) {
  opts = opts || {};
  if (!config.scriptUrl) {
    pendingSync.add(couple.id);
    savePendingSync();
    return;
  }
  try {
    const totalPaid = getTotalPaid(couple);
    const cost = config.cost || 0;
    const pending = Math.max(0, cost - totalPaid);
    let payStatus = 'Sin pago';
    if (cost > 0 && totalPaid >= cost) payStatus = 'Pagado';
    else if (totalPaid > 0) payStatus = 'Parcial';
    if (couple.cancelacion) payStatus = 'Cancelada';

    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upsertCouple',
        couple: {
          id: couple.id, him: couple.him, her: couple.her,
          telHim: couple.telHim || '', telHer: couple.telHer || '',
          emailHim: couple.emailHim || '', emailHer: couple.emailHer || '',
          amount: totalPaid, pending, payStatus,
          comments: couple.comments || '',
          regDate: couple.regDate || '', eventDate: couple.eventDate || '',
          docsActa: couple.docs && couple.docs.acta ? 'Sí' : 'No',
          docsId:   couple.docs && couple.docs.idHim && couple.docs.idHer ? 'Sí' : 'No',
          docsPhoto:couple.docs && couple.docs.photo ? 'Sí' : 'No',
          createdBy: couple.createdBy || '', createdAt: couple.createdAt || '',
          beca: couple.beca ? { amount: couple.beca.amount, reason: couple.beca.reason || '' } : null,
          penalizacion: couple.penalizacion ? { amount: couple.penalizacion.amount, reason: couple.penalizacion.reason || '' } : null,
          penalizacionCleared: !!opts.clearPenalizacion,
          cancelacion: couple.cancelacion ? { type: couple.cancelacion.type } : null,
          payments: (couple.payments || []).map(p => ({
            id: p.id, amount: p.amount, date: p.date,
            receivedBy: p.receivedBy, method: p.method, note: p.note,
            registeredBy: p.registeredBy
          }))
        }
      })
    });
    pendingSync.delete(couple.id);
    savePendingSync();
    updateSyncBadge();
  } catch (e) {
    pendingSync.add(couple.id);
    savePendingSync();
    updateSyncBadge();
    console.warn('Auto-sync failed, queued:', couple.id);
  }
}

async function retryPendingSync() {
  if (pendingSync.size === 0 || !config.scriptUrl) return;
  const toRetry = [...pendingSync];
  for (const id of toRetry) {
    const c = couples.find(x => x.id === id);
    if (c) await autoSyncCouple(c);
  }
}

function updateSyncBadge() {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (pendingSync.size > 0) {
    el.innerHTML = '<span style="background:#B06000;color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;">⟳ ' + pendingSync.size + ' pendiente(s)</span>';
  } else {
    el.innerHTML = '';
  }
}

// ===== SINCRONIZACIÓN COMPLETA (Admin + Reg. Principal) =====
async function fullSync() {
  if (!config.scriptUrl) { showToast('Configura la URL del Apps Script primero', 'error'); return; }

  const btn = document.getElementById('btn-full-sync');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Sincronizando...'; }

  let uploaded = 0, downloaded = 0, errors = 0;

  try {
    // 0. Subir también la lista de usuarios de este dispositivo (con
    // contraseña) y la configuración del evento, para que cualquier otro
    // dispositivo que abra el enlace las descargue automáticamente.
    if (users.length > 0) await pushUsersToServer();
    await pushConfigToServer();

    // 1. SUBIR — enviar todas las parejas locales (upsert)
    for (const c of couples) {
      try {
        await autoSyncCouple(c);
        uploaded++;
        await new Promise(r => setTimeout(r, 150));
      } catch (e) { errors++; }
    }

    // 2. BAJAR — descargar desde Sheets y hacer merge
    const res = await fetch(config.scriptUrl + '?action=getCouples', { mode: 'cors' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.couples && data.couples.length > 0) {
        const localMap = {};
        couples.forEach(c => { localMap[c.id] = c; });

        data.couples.forEach(sc => {
          if (!sc.id || (!sc.him && !sc.her)) return;
          if (localMap[sc.id]) {
            const local = localMap[sc.id];
            localMap[sc.id] = {
              ...local,
              him: sc.him || local.him,
              her: sc.her || local.her,
              telHim: sc.telHim || local.telHim,
              telHer: sc.telHer || local.telHer,
              emailHim: sc.emailHim || local.emailHim,
              emailHer: sc.emailHer || local.emailHer,
              comments: sc.comments || local.comments,
              docs: local.docs || {},
              docLog: local.docLog || [],
              payments: mergePayments(local.payments, sc.payments),
            };
          } else {
            localMap[sc.id] = { ...sc, docs: {}, docLog: [], payments: sc.payments || [] };
            downloaded++;
          }
        });

        couples = Object.values(localMap);
        couples.forEach((c, i) => {
          if (c.payments && c.payments.length > 0) {
            couples[i].amount = c.payments.reduce((s, p) => s + (p.amount || 0), 0);
          }
        });
        saveToStorage();
        refreshDashboard();
        renderCouples();
      }
    }

    const msg = '✅ Subidas: ' + uploaded + ' · Nuevas bajadas: ' + downloaded + (errors > 0 ? ' · Errores: ' + errors : '');
    showToast(msg, 'success');
    const resultEl = document.getElementById('sync-result');
    if (resultEl) { resultEl.textContent = msg; resultEl.classList.remove('hidden'); }
    updateSyncBadge();

  } catch (e) {
    showToast('Error de sincronización', 'error');
  }

  if (btn) { btn.disabled = false; btn.textContent = '⟳ Sincronizar'; }
}

// ===== ACTUALIZAR — solo descarga (para Registradores) =====
async function downloadFromSheets() {
  if (!config.scriptUrl) { showToast('Sin conexión configurada', 'error'); return; }
  const btn = document.getElementById('btn-download-sync');
  if (btn) { btn.disabled = true; btn.textContent = '↓ Actualizando...'; }

  try {
    const res = await fetch(config.scriptUrl + '?action=getCouples', { mode: 'cors' });
    if (!res.ok) { showToast('Error de conexión', 'error'); if (btn) { btn.disabled = false; btn.textContent = '↓ Actualizar lista'; } return; }
    const data = await res.json();

    if (data && data.couples && data.couples.length > 0) {
      const localMap = {};
      couples.forEach(c => { localMap[c.id] = c; });
      let newCount = 0;

      data.couples.forEach(sc => {
        if (!sc.id || (!sc.him && !sc.her)) return;
        if (localMap[sc.id]) {
          const local = localMap[sc.id];
          localMap[sc.id] = {
            ...local,
            him: sc.him || local.him,
            her: sc.her || local.her,
            telHim: sc.telHim || local.telHim,
            telHer: sc.telHer || local.telHer,
            comments: sc.comments || local.comments,
            docs: local.docs || {},
            docLog: local.docLog || [],
            payments: mergePayments(local.payments, sc.payments),
          };
        } else {
          localMap[sc.id] = { ...sc, docs: {}, docLog: [], payments: sc.payments || [] };
          newCount++;
        }
      });

      couples = Object.values(localMap);
      couples.forEach((c, i) => {
        if (c.payments && c.payments.length > 0) {
          couples[i].amount = c.payments.reduce((s, p) => s + (p.amount || 0), 0);
        }
      });
      saveToStorage();
      refreshDashboard();
      renderCouples();
      showToast('✅ Actualizado' + (newCount > 0 ? ' · ' + newCount + ' registros nuevos' : ''), 'success');
    } else {
      showToast('No hay datos nuevos', '');
    }
  } catch (e) {
    showToast('Error al actualizar', 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '↓ Actualizar lista'; }
}

async function testConnection() {
  const btn = document.querySelector('[onclick="testConnection()"]');
  const statusEl = document.getElementById('conn-status');
  if (btn) { btn.textContent = 'Probando...'; btn.disabled = true; }
  if (!config.scriptUrl) {
    statusEl.innerHTML = '<span class="dot red"></span> Sin URL configurada';
    if (btn) { btn.textContent = 'Probar conexión'; btn.disabled = false; }
    return;
  }
  try {
    const res = await fetch(config.scriptUrl + '?action=ping', { mode: 'cors' });
    statusEl.innerHTML = res.ok
      ? '<span class="dot green"></span> Conectado a Google Sheets'
      : '<span class="dot amber"></span> Respuesta inesperada';
  } catch (e) {
    statusEl.innerHTML = '<span class="dot red"></span> No se pudo conectar — verifica la URL';
  }
  if (btn) { btn.textContent = 'Probar conexión'; btn.disabled = false; }
}

function logActivity(msg) {
  // Log local — la actividad se registra en Sheets durante el syncAll
  console.log('[REMA]', msg);
}

async function syncPaymentToSheets(payment, couple) {
  if (!config.scriptUrl) return;
  try {
    const totalPaid = getTotalPaid(couple);
    const cost = config.cost || 0;
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'savePayment',
        payment,
        coupleUpdate: {
          id: couple.id, totalPaid,
          pending: Math.max(0, cost - totalPaid),
          payStatus: cost > 0 && totalPaid >= cost ? 'Pagado' : totalPaid > 0 ? 'Parcial' : 'Sin pago',
          numPayments: couple.payments.length,
        }
      })
    });
  } catch (e) { console.warn('Payment sync error:', e); }
}

async function syncToSheets(couple) {
  if (!config.scriptUrl) return;
  try {
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'saveCouple',
        couple: {
          id: couple.id, him: couple.him, her: couple.her,
          telHim: couple.telHim, telHer: couple.telHer,
          emailHim: couple.emailHim, emailHer: couple.emailHer,
          amount: getTotalPaid(couple),
          comments: couple.comments, regDate: couple.regDate, eventDate: couple.eventDate,
          docsActa: couple.docs && couple.docs.acta ? 'Sí' : 'No',
          docsId: couple.docs && couple.docs.idHim && couple.docs.idHer ? 'Sí' : 'No',
          docsPhoto: couple.docs && couple.docs.photo ? 'Sí' : 'No',
          createdBy: couple.createdBy, createdAt: couple.createdAt,
        }
      })
    });
  } catch (e) { console.warn('Sheets sync error:', e); }
}

async function resetAndSync() {
  if (!config.scriptUrl) { showToast('Configura primero la URL del Apps Script', 'error'); return; }
  if (!confirm('⚠️ Esto borrará TODOS los datos locales y los reemplazará con los de Google Sheets.\n\nLos documentos (fotos/PDFs) guardados localmente se perderán.\n\n¿Continuar?')) return;

  showToast('Descargando datos de Sheets...', '');

  try {
    const res = await fetch(config.scriptUrl + '?action=getCouples', { mode: 'cors' });
    if (!res.ok) { showToast('Error de conexión', 'error'); return; }
    const data = await res.json();

    if (!data || !data.couples || data.couples.length === 0) {
      showToast('No hay datos en Sheets para descargar', 'error');
      return;
    }

    const validCouples = data.couples.filter(c => c.id && (c.him || c.her));
    if (validCouples.length === 0) {
      showToast('Los datos de Sheets no son válidos', 'error');
      return;
    }

    // Limpiar y reemplazar con datos limpios de Sheets
    couples = validCouples.map(c => ({
      ...c,
      docs: c.docs || {},
      docLog: [],
      payments: c.payments || [],
      amount: (c.payments || []).reduce((s, p) => s + (p.amount || 0), 0) || c.amount || 0,
    }));

    saveToStorage();
    refreshDashboard();
    renderCouples();
    showToast('✅ ' + couples.length + ' parejas descargadas de Sheets', 'success');
  } catch (e) {
    showToast('Error al descargar: ' + e.message, 'error');
  }
}

async function syncFromSheets(silent = false) {
  if (!config.scriptUrl) return;
  try {
    if (!silent) showSyncIndicator('syncing');
    const res = await fetch(config.scriptUrl + '?action=getCouples', { mode: 'cors' });
    if (!res.ok) { if (!silent) showSyncIndicator('error'); return; }
    const data = await res.json();
    if (data && data.couples && data.couples.length > 0) {
      // Validar que los datos tengan nombres válidos
      const validCouples = data.couples.filter(c => c.id && (c.him || c.her));
      if (validCouples.length === 0) {
        if (!silent) showSyncIndicator('error');
        return;
      }

      // Merge: actualizar datos de Sheets, preservar docs y pagos locales
      const localMap = {};
      couples.forEach(c => { localMap[c.id] = c; });

      validCouples.forEach(sc => {
        if (localMap[sc.id]) {
          const local = localMap[sc.id];
          // Solo actualizar si los datos de Sheets son válidos
          if (sc.him && sc.her) {
            localMap[sc.id] = {
              ...local,         // base local
              him: sc.him,      // actualizar datos básicos desde Sheets
              her: sc.her,
              telHim: sc.telHim || local.telHim,
              telHer: sc.telHer || local.telHer,
              emailHim: sc.emailHim || local.emailHim,
              emailHer: sc.emailHer || local.emailHer,
              regDate: sc.regDate || local.regDate,
              eventDate: sc.eventDate || local.eventDate,
              comments: sc.comments || local.comments,
              // Preservar siempre lo local
              docs: local.docs || {},
              docLog: local.docLog || [],
              payments: mergePayments(local.payments, sc.payments),
              beca: local.beca || sc.beca,
              penalizacion: local.penalizacion || sc.penalizacion,
              cancelacion: local.cancelacion || sc.cancelacion,
            };
          }
        } else if (sc.him && sc.her) {
          // Nueva pareja de Sheets — solo agregar si tiene nombres válidos
          localMap[sc.id] = {
            ...sc,
            docs: {},
            docLog: [],
            payments: sc.payments || [],
          };
        }
      });

      couples = Object.values(localMap);

      // Recalcular totales
      couples.forEach((c, i) => {
        if (c.payments && c.payments.length > 0) {
          couples[i].amount = c.payments.reduce((s, p) => s + (p.amount || 0), 0);
        }
      });

      saveToStorage();
      lastSyncTime = new Date();
      refreshDashboard();
      renderCouples();
    }
    if (!silent) showSyncIndicator('ok');
  } catch (e) {
    console.warn('Sync error:', e);
    if (!silent) showSyncIndicator('error');
  }
}

function showSyncIndicator(status) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (status === 'syncing') {
    el.innerHTML = '<span style="color:rgba(255,255,255,0.7);font-size:11px">⟳ Sincronizando...</span>';
  } else if (status === 'ok') {
    const time = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = '<span style="color:rgba(255,255,255,0.7);font-size:11px">✓ Sync ' + time + '</span>';
    setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
  } else {
    el.innerHTML = '<span style="color:rgba(255,200,180,0.8);font-size:11px">⚠ Sin conexión</span>';
    setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
  }
}

async function testConnection() {
  const btn = document.querySelector('[onclick="testConnection()"]');
  const statusEl = document.getElementById('conn-status');
  btn.textContent = 'Probando...'; btn.disabled = true;
  if (!config.scriptUrl) {
    statusEl.innerHTML = '<span class="dot red"></span> Sin URL configurada';
    btn.textContent = 'Probar conexión'; btn.disabled = false; return;
  }
  try {
    const res = await fetch(config.scriptUrl + '?action=ping', { mode: 'cors' });
    statusEl.innerHTML = res.ok
      ? '<span class="dot green"></span> Conectado a Google Sheets'
      : '<span class="dot amber"></span> Respuesta inesperada';
  } catch (e) {
    statusEl.innerHTML = '<span class="dot red"></span> No se pudo conectar — verifica la URL';
  }
  btn.textContent = 'Probar conexión'; btn.disabled = false;
}

// ===== MODALES =====
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
});

// ===== TOAST =====
let toastTimer;
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}