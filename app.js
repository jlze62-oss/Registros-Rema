// ===== ESTADO GLOBAL =====
let currentUser = null;
let couples = [];
let config = {};
let users = [];
let currentFilter = 'all';
let editingCoupleId = null;
let docData = { acta: null, id: null, photo: null };
let detailCoupleId = null;

// ===== INICIALIZACIÓN =====
window.addEventListener('load', () => {
  loadFromStorage();
  checkSession();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});

function loadFromStorage() {
  config = JSON.parse(localStorage.getItem('rm_config') || '{}');
  users = JSON.parse(localStorage.getItem('rm_users') || '[]');
  couples = JSON.parse(localStorage.getItem('rm_couples') || '[]');
  if (users.length === 0) {
    users = [
      { id: 1, name: 'Administrador', email: 'admin', password: 'admin123', role: 'admin' },
      { id: 2, name: 'Registrador', email: 'registro', password: 'registro123', role: 'registrador' }
    ];
    saveUsers();
  }
}

function checkSession() {
  const session = sessionStorage.getItem('rm_session');
  if (session) { currentUser = JSON.parse(session); showApp(); }
}

function saveToStorage() { localStorage.setItem('rm_couples', JSON.stringify(couples)); }
function saveUsers() { localStorage.setItem('rm_users', JSON.stringify(users)); }

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
}

// ===== LOGIN =====
function doLogin() {
  const email = document.getElementById('login-user').value.trim().toLowerCase();
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  const user = users.find(u => u.email.toLowerCase() === email && u.password === pass);
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
  const isAdmin = currentUser.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));
  document.getElementById('nav-avatar').textContent = (currentUser.name || 'U').charAt(0).toUpperCase();
  document.getElementById('nav-username').textContent = currentUser.name;
  document.getElementById('nav-role').textContent = isAdmin ? 'Administrador' : 'Registrador';
  if (isAdmin) {
    document.getElementById('cfg-event-name').value = config.eventName || '';
    document.getElementById('cfg-date-start').value = config.dateStart || '';
    document.getElementById('cfg-date-end').value = config.dateEnd || '';
    document.getElementById('cfg-cost').value = config.cost || '';
    document.getElementById('cfg-sheet-id').value = config.sheetId || '';
    document.getElementById('cfg-script-url').value = config.scriptUrl || '';
  }
  showView('dashboard');
  if (config.scriptUrl) syncFromSheets();
}

// ===== NAVEGACIÓN =====
function showView(view) {
  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.style.display = 'none'; });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) { viewEl.classList.add('active'); viewEl.style.display = 'block'; }
  const navEl = document.querySelector('[data-view="' + view + '"]');
  if (navEl) navEl.classList.add('active');
  const titles = { dashboard: 'Inicio', couples: 'Matrimonios', payments: 'Pagos', documents: 'Documentos', config: 'Configuración', users: 'Usuarios' };
  document.getElementById('topbar-title').textContent = titles[view] || view;
  document.getElementById('btn-new-couple').style.display = ['couples', 'dashboard'].includes(view) ? 'flex' : 'none';
  toggleSidebar(false);
  window.scrollTo(0, 0);
  if (view === 'dashboard') refreshDashboard();
  if (view === 'couples') renderCouples();
  if (view === 'payments') renderPayments();
  if (view === 'documents') renderDocuments();
  if (view === 'users') renderUsers();
}

function toggleSidebar(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !document.getElementById('sidebar').classList.contains('open');
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebar-overlay').classList.toggle('hidden', !open);
}

// ===== HELPERS =====
function getTotalPaid(c) {
  if (c.payments && c.payments.length > 0) return c.payments.reduce((s, p) => s + (p.amount || 0), 0);
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
  const done = [d.acta, d.id, d.photo].filter(Boolean).length;
  return { done, total: 3, complete: done === 3 };
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
  const badgeMap = { paid: ['badge-paid','Pagado'], partial: ['badge-partial','Parcial'], nopay: ['badge-nopay','Sin pago'] };
  const [bClass, bText] = badgeMap[status];
  const docBadge = docsStatus.complete
    ? '<span class="badge badge-docs-ok" style="margin-left:4px">Docs ✓</span>'
    : '<span class="badge badge-docs-pend" style="margin-left:4px">Docs ' + docsStatus.done + '/3</span>';
  return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
    '<div class="couple-avatar">♡</div>' +
    '<div class="couple-info">' +
      '<div class="couple-names">' + esc(c.him) + ' & ' + esc(c.her) + '</div>' +
      '<div class="couple-meta">' + formatDate(c.regDate) + docBadge + '</div>' +
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
    const icon = p.method === 'transferencia' ? '🏦' : '💵';
    const methodLabel = p.method === 'transferencia' ? 'Transferencia' : 'Efectivo';
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
    const items = [{ key:'acta', icon:'📋', label:'Acta' }, { key:'id', icon:'🪪', label:'ID' }, { key:'photo', icon:'📷', label:'Foto' }];
    const docIcons = items.map(i =>
      '<div style="text-align:center;opacity:' + (d[i.key] ? 1 : 0.2) + '">' +
        '<div style="font-size:20px">' + i.icon + '</div>' +
        '<div style="font-size:9px;color:' + (d[i.key] ? '#1E7B3C' : '#888') + '">' + i.label + '</div>' +
      '</div>'
    ).join('');
    return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
      '<div class="couple-avatar" style="font-size:13px;background:' + (docsStatus.complete ? '#EAF7EE' : '#FFF4E5') + '">' +
        '<span style="color:' + (docsStatus.complete ? '#1E7B3C' : '#B06000') + '">' + docsStatus.done + '/3</span>' +
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
  document.getElementById('detail-title').textContent = c.him + ' & ' + c.her;
  const cost = config.cost || 0;
  const payments = c.payments || [];
  const totalPaid = getTotalPaid(c);
  const pending = Math.max(0, cost - totalPaid);
  const docsStatus = getDocsStatus(c);
  const d = c.docs || {};
  const efectivo = payments.filter(p => p.method !== 'transferencia').reduce((s, p) => s + p.amount, 0);
  const transf = payments.filter(p => p.method === 'transferencia').reduce((s, p) => s + p.amount, 0);

  // Historial de pagos
  let paymentsHTML = payments.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin abonos aún — usa el botón verde abajo.</div>'
    : '<div class="payment-history">' + payments.map((p, i) => {
        const acum = payments.slice(0, i + 1).reduce((s, x) => s + x.amount, 0);
        const icon = p.method === 'transferencia' ? '🏦' : '💵';
        return '<div class="payment-item">' +
          '<div class="payment-dot ' + (i === 0 ? 'first' : '') + '"></div>' +
          '<div class="payment-info">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<div class="payment-amount">' + icon + ' $' + fmtMoney(p.amount) + '</div>' +
              '<button onclick="deletePayment(\'' + c.id + '\',\'' + p.id + '\')" style="background:none;border:none;color:#ddd;font-size:16px;cursor:pointer;padding:0 0 0 8px;">✕</button>' +
            '</div>' +
            '<div class="payment-meta">' + formatDate(p.date) + ' · ' + esc(p.receivedBy || '—') + ' · ' + (p.method === 'transferencia' ? 'Transferencia' : 'Efectivo') + '</div>' +
            (p.note ? '<div class="payment-note">"' + esc(p.note) + '"</div>' : '') +
            '<div class="payment-acum">Acumulado hasta aquí: $' + fmtMoney(acum) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';

  // Documentos con botones Ver / Subir
  const docItems = [
    { key: 'acta', label: 'Acta de matrimonio', icon: '📋' },
    { key: 'id', label: 'Identificación', icon: '🪪' },
    { key: 'photo', label: 'Foto juntos', icon: '📷' },
  ];
  const docRows = docItems.map(item => {
    const has = d[item.key];
    return '<div class="detail-row">' +
      '<span class="detail-lbl">' + item.icon + ' ' + item.label + '</span>' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="font-size:12px;color:' + (has ? '#1E7B3C' : '#B06000') + '">' + (has ? '✓ Cargado' : '⏳ Pendiente') + '</span>' +
        (has
          ? '<button onclick="viewDoc(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-view">Ver</button>'
          : '<button onclick="openDocUpload(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-upload">+ Subir</button>') +
        (has ? '<button onclick="openDocUpload(\'' + c.id + '\',\'' + item.key + '\')" class="btn-doc-action btn-replace">Reemplazar</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  const logHTML = (c.docLog || []).slice(-8).reverse().map(l =>
    '<div class="doc-log-item"><span class="log-time">' + esc(l.ts) + '</span> ' + esc(l.user) + ' subió ' + esc(l.doc) + '</div>'
  ).join('') || '<div style="color:#aaa;font-size:12px;">Sin actividad</div>';

  document.getElementById('detail-body').innerHTML =
    '<div class="section-label">Participantes</div>' +
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
    (efectivo > 0 ? '<div class="detail-row"><span class="detail-lbl">💵 Efectivo</span><span class="detail-val">$' + fmtMoney(efectivo) + '</span></div>' : '') +
    (transf > 0 ? '<div class="detail-row"><span class="detail-lbl">🏦 Transferencia</span><span class="detail-val">$' + fmtMoney(transf) + '</span></div>' : '') +
    '<div class="detail-row"><span class="detail-lbl">No. abonos</span><span class="detail-val">' + payments.length + '</span></div>' +

    '<div class="section-label mt16">Historial de abonos</div>' +
    paymentsHTML +

    '<div class="section-label mt16">Documentos (' + docsStatus.done + '/3)</div>' +
    docRows +
    '<div style="margin-top:10px">' + logHTML + '</div>' +

    (c.comments ? '<div class="section-label mt16">Comentarios</div><div style="font-size:13px;color:#555;padding:6px 0;">' + esc(c.comments) + '</div>' : '') +
    '<div class="section-label mt16">Datos del registro</div>' +
    '<div class="detail-row"><span class="detail-lbl">Fecha registro</span><span class="detail-val">' + formatDate(c.regDate) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Evento</span><span class="detail-val">' + esc(c.eventDate || '—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Registrado por</span><span class="detail-val">' + esc(c.createdBy || '—') + '</span></div>';
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

// ===== SUBIR DOCUMENTO INDIVIDUAL =====
let uploadingDocKey = null;
let uploadingCoupleId = null;

function openDocUpload(coupleId, docKey) {
  uploadingDocKey = docKey;
  uploadingCoupleId = coupleId;
  const labels = { acta: '📋 Acta de matrimonio', id: '🪪 Identificación', photo: '📷 Foto juntos' };
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
  const docNames = { acta: 'acta de matrimonio', id: 'identificación', photo: 'foto juntos' };
  couples[idx].docLog.push({ ts: new Date().toISOString().split('T')[0], user: currentUser.name, doc: docNames[uploadingDocKey] });
  saveToStorage();
  closeModal('modal-doc-upload');
  showToast('Documento guardado ✓', 'success');
  setTimeout(() => openDetail(uploadingCoupleId), 200);
  renderDocuments();
}

// ===== MODAL DE PAGO =====
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
  syncPaymentToSheets(payment, couples[idx]);
  closeModal('modal-payment');
  setTimeout(() => { openDetail(detailCoupleId); showToast('Abono registrado ✓', 'success'); }, 200);
  refreshDashboard();
  renderCouples();
  renderPayments();
}

function deleteCouple() {
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  if (!confirm('¿Eliminar el registro de ' + c.him + ' & ' + c.her + '?\n\nEsta acción no se puede deshacer.')) return;
  couples = couples.filter(x => x.id !== detailCoupleId);
  saveToStorage();
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
  docData = { acta: null, id: null, photo: null };
  ['cp-him','cp-her','cp-tel-him','cp-tel-her','cp-email-him','cp-email-her','cp-amount','cp-received-by','cp-comments'].forEach(f => {
    const el = document.getElementById(f);
    if (el) el.value = '';
  });
  const methodEl = document.getElementById('cp-method');
  if (methodEl) methodEl.value = 'efectivo';
  ['acta','id','photo'].forEach(k => {
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
        ['acta','id','photo'].forEach(k => {
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
    ['acta','id','photo'].forEach(k => {
      if (docData[k] && docData[k].data && (!couple.docs || !couple.docs[k])) {
        docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta:'acta de matrimonio', id:'identificación', photo:'foto juntos' }[k] });
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
    ['acta','id','photo'].forEach(k => { if (docData[k] && docData[k].data) couple.docs[k] = docData[k]; });
    couples[idx] = couple;
  } else {
    const docLog = [];
    ['acta','id','photo'].forEach(k => {
      if (docData[k] && docData[k].data) docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta:'acta de matrimonio', id:'identificación', photo:'foto juntos' }[k] });
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
      docs: { acta: docData.acta, id: docData.id, photo: docData.photo },
      docLog, createdBy: currentUser.name, createdAt: now,
    };
    if (couple.payments.length > 0) couple.payments[0].coupleId = couple.id;
    couples.unshift(couple);
  }
  saveToStorage();
  syncToSheets(couple);
  btn.disabled = false; btn.textContent = 'Guardar registro';
  closeModal('modal-couple');
  showToast(editingCoupleId ? 'Registro actualizado ✓' : 'Pareja registrada ✓', 'success');
  refreshDashboard(); renderCouples();
}

// ===== USERS =====
function renderUsers() {
  document.getElementById('users-list').innerHTML = users.map(u =>
    '<div class="user-item">' +
      '<div class="user-avatar">' + esc(u.name.charAt(0).toUpperCase()) + '</div>' +
      '<div class="user-item-info"><div class="user-item-name">' + esc(u.name) + '</div><div class="user-item-email">' + esc(u.email) + '</div></div>' +
      '<span class="badge ' + (u.role === 'admin' ? 'badge-admin' : 'badge-reg') + '">' + (u.role === 'admin' ? 'Admin' : 'Registrador') + '</span>' +
    '</div>'
  ).join('');
}

function openNewUserModal() {
  ['u-name','u-email','u-pass'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('u-role').value = 'registrador';
  document.getElementById('modal-user').classList.remove('hidden');
}

function saveUser() {
  const name = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const pass = document.getElementById('u-pass').value;
  const role = document.getElementById('u-role').value;
  if (!name || !email || !pass) { showToast('Completa todos los campos', 'error'); return; }
  if (pass.length < 6) { showToast('Contraseña mínimo 6 caracteres', 'error'); return; }
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) { showToast('Ya existe ese usuario', 'error'); return; }
  users.push({ id: Date.now(), name, email, password: pass, role });
  saveUsers(); renderUsers();
  closeModal('modal-user');
  showToast('Usuario agregado ✓', 'success');
}

// ===== GOOGLE SHEETS SYNC =====
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
          docsId: couple.docs && couple.docs.id ? 'Sí' : 'No',
          docsPhoto: couple.docs && couple.docs.photo ? 'Sí' : 'No',
          createdBy: couple.createdBy, createdAt: couple.createdAt,
        }
      })
    });
  } catch (e) { console.warn('Sheets sync error:', e); }
}

async function syncFromSheets() {
  if (!config.scriptUrl) return;
  try {
    const res = await fetch(config.scriptUrl + '?action=getCouples', { mode: 'cors' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.couples) {
      data.couples.forEach(sc => {
        if (!couples.find(c => c.id === sc.id)) couples.push({ ...sc, docs: {}, docLog: [], payments: [] });
      });
      saveToStorage(); refreshDashboard();
    }
  } catch (e) { console.warn('Sheets read error:', e); }
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
