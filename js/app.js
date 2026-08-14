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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
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
  if (session) {
    currentUser = JSON.parse(session);
    showApp();
  }
}

function saveToStorage() {
  localStorage.setItem('rm_couples', JSON.stringify(couples));
}
function saveUsers() {
  localStorage.setItem('rm_users', JSON.stringify(users));
}

// ===== CONFIGURACIÓN =====
function saveConfig() {
  const cfg = {
    eventName: document.getElementById('cfg-event-name').value,
    dateStart: document.getElementById('cfg-date-start').value,
    dateEnd: document.getElementById('cfg-date-end').value,
    cost: parseFloat(document.getElementById('cfg-cost').value) || 0,
    sheetId: document.getElementById('cfg-sheet-id').value,
    scriptUrl: document.getElementById('cfg-script-url').value,
  };
  config = cfg;
  localStorage.setItem('rm_config', JSON.stringify(cfg));
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
  if (e.key === 'Enter') {
    const loginScreen = document.getElementById('screen-login');
    if (!loginScreen.classList.contains('hidden')) doLogin();
  }
});

function doLogout() {
  currentUser = null;
  sessionStorage.removeItem('rm_session');
  document.getElementById('screen-app').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  toggleSidebar(false);
}

function showApp() {
  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');
  const isAdmin = currentUser.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));
  const initial = (currentUser.name || 'U').charAt(0).toUpperCase();
  document.getElementById('nav-avatar').textContent = initial;
  document.getElementById('nav-username').textContent = currentUser.name;
  document.getElementById('nav-role').textContent = isAdmin ? 'Administrador' : 'Registrador';
  if (isAdmin && config.eventName) {
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
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.style.display = 'none';
  });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) { viewEl.classList.add('active'); viewEl.style.display = 'block'; }
  const navEl = document.querySelector('[data-view="' + view + '"]');
  if (navEl) navEl.classList.add('active');
  const titles = { dashboard: 'Inicio', couples: 'Matrimonios', payments: 'Pagos', documents: 'Documentos', config: 'Configuración', users: 'Usuarios' };
  document.getElementById('topbar-title').textContent = titles[view] || view;
  const showPlus = ['couples', 'dashboard'].includes(view);
  document.getElementById('btn-new-couple').style.display = showPlus ? 'flex' : 'none';
  toggleSidebar(false);
  window.scrollTo(0, 0);
  if (view === 'dashboard') refreshDashboard();
  if (view === 'couples') renderCouples();
  if (view === 'payments') renderPayments();
  if (view === 'documents') renderDocuments();
  if (view === 'users') renderUsers();
}

function toggleSidebar(forceOpen) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = sidebar.classList.contains('open');
  const open = forceOpen !== undefined ? forceOpen : !isOpen;
  sidebar.classList.toggle('open', open);
  overlay.classList.toggle('hidden', !open);
}

// ===== DASHBOARD =====
function refreshDashboard() {
  const eventName = config.eventName || 'Sin evento configurado';
  const cost = config.cost || 0;
  const dateStart = config.dateStart ? formatDate(config.dateStart) : '—';
  const dateEnd = config.dateEnd ? formatDate(config.dateEnd) : '';
  const dateRange = dateEnd ? dateStart + ' – ' + dateEnd : dateStart;
  document.getElementById('event-name-banner').textContent = eventName;
  document.getElementById('event-dates-banner').textContent = dateRange;
  document.getElementById('event-cost-banner').innerHTML = '$' + fmtMoney(cost) + '<br><span style="font-size:10px;opacity:0.7">por pareja</span>';
  const total = couples.length;
  const paid = couples.filter(c => getTotalPaid(c) >= cost && cost > 0).length;
  const docsOk = couples.filter(c => c.docs && c.docs.acta && c.docs.id && c.docs.photo).length;
  const pending = couples.filter(c => getTotalPaid(c) < cost).length;
  document.getElementById('stat-couples').textContent = total;
  document.getElementById('stat-paid').textContent = paid;
  document.getElementById('stat-docs').textContent = docsOk;
  document.getElementById('stat-pending').textContent = pending;
  const totalCollected = couples.reduce((s, c) => s + getTotalPaid(c), 0);
  const totalPending = Math.max(0, couples.length * cost - totalCollected);
  const pct = total > 0 && cost > 0 ? Math.round(totalCollected / (total * cost) * 100) : 0;
  document.getElementById('total-collected').textContent = '$' + fmtMoney(totalCollected);
  document.getElementById('total-pending').textContent = '$' + fmtMoney(totalPending);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('pct-badge').textContent = pct + '%';
  const recent = [...couples].sort((a, b) => new Date(b.regDate) - new Date(a.regDate)).slice(0, 5);
  const recentEl = document.getElementById('recent-list');
  recentEl.innerHTML = recent.length === 0
    ? '<p style="color:#888;font-size:13px;padding:8px 0;">No hay registros aún.</p>'
    : recent.map(c => coupleItemHTML(c)).join('');
}

// ===== HELPER: total pagado de una pareja =====
function getTotalPaid(c) {
  if (c.payments && c.payments.length > 0) {
    return c.payments.reduce((s, p) => s + (p.amount || 0), 0);
  }
  return c.amount || 0;
}

// ===== COUPLES =====
function renderCouples() {
  const search = (document.getElementById('search-couples').value || '').toLowerCase();
  const cost = config.cost || 0;
  let list = couples.filter(c => {
    const name = (c.him + ' ' + c.her).toLowerCase();
    if (search && !name.includes(search)) return false;
    const paid = getTotalPaid(c);
    if (currentFilter === 'paid') return paid >= cost && cost > 0;
    if (currentFilter === 'partial') return paid > 0 && paid < cost;
    if (currentFilter === 'nopay') return paid === 0;
    return true;
  });
  const el = document.getElementById('couples-list');
  const empty = document.getElementById('couples-empty');
  if (list.length === 0) { el.innerHTML = ''; empty.classList.remove('hidden'); }
  else { empty.classList.add('hidden'); el.innerHTML = list.map(c => coupleItemHTML(c)).join(''); }
}

function filterCouples() { renderCouples(); }

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCouples();
}

function coupleItemHTML(c) {
  const cost = config.cost || 0;
  const paid = getTotalPaid(c);
  let badgeClass = 'badge-nopay', badgeText = 'Sin pago';
  if (cost > 0 && paid >= cost) { badgeClass = 'badge-paid'; badgeText = 'Pagado'; }
  else if (paid > 0) { badgeClass = 'badge-partial'; badgeText = 'Parcial'; }
  const docsOk = c.docs && c.docs.acta && c.docs.id && c.docs.photo;
  const docBadge = docsOk
    ? '<span class="badge badge-docs-ok" style="margin-left:4px">Docs ✓</span>'
    : '<span class="badge badge-docs-pend" style="margin-left:4px">Docs ⏳</span>';
  return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
    '<div class="couple-avatar">♡</div>' +
    '<div class="couple-info">' +
      '<div class="couple-names">' + c.him + ' & ' + c.her + '</div>' +
      '<div class="couple-meta">' + formatDate(c.regDate) + ' ' + docBadge + '</div>' +
    '</div>' +
    '<div class="couple-right">' +
      '<div class="couple-amount">$' + fmtMoney(paid) + '</div>' +
      '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
    '</div>' +
  '</div>';
}

// ===== PAYMENTS VIEW =====
function renderPayments() {
  const el = document.getElementById('payments-list');
  const cost = config.cost || 0;
  if (couples.length === 0) { el.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">No hay pagos registrados.</p>'; return; }
  el.innerHTML = couples.map(c => {
    const paid = getTotalPaid(c);
    const pending = Math.max(0, cost - paid);
    const numAbonos = (c.payments || []).length;
    return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
      '<div class="couple-avatar">$</div>' +
      '<div class="couple-info">' +
        '<div class="couple-names">' + c.him + ' & ' + c.her + '</div>' +
        '<div class="couple-meta">' + numAbonos + ' abono(s)</div>' +
      '</div>' +
      '<div class="couple-right">' +
        '<div style="font-size:13px;color:#1E7B3C;font-weight:600">$' + fmtMoney(paid) + '</div>' +
        (pending > 0 ? '<div style="font-size:11px;color:#B06000">Pend: $' + fmtMoney(pending) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ===== DOCUMENTS VIEW =====
function renderDocuments() {
  const el = document.getElementById('docs-list');
  if (couples.length === 0) { el.innerHTML = '<div class="card"><p style="color:#888;font-size:13px;padding:8px 0;">No hay registros.</p></div>'; return; }
  el.innerHTML = couples.map(c => {
    const d = c.docs || {};
    const items = [{ key:'acta',icon:'📋' },{ key:'id',icon:'🪪' },{ key:'photo',icon:'📷' }];
    const docIcons = items.map(i => '<span style="font-size:18px;opacity:' + (d[i.key] ? 1 : 0.25) + '">' + i.icon + '</span>').join('');
    return '<div class="couple-item" onclick="openDetail(\'' + c.id + '\')">' +
      '<div class="couple-avatar" style="font-size:14px">DOC</div>' +
      '<div class="couple-info">' +
        '<div class="couple-names">' + c.him + ' & ' + c.her + '</div>' +
        '<div style="display:flex;gap:6px;margin-top:4px">' + docIcons + '</div>' +
      '</div>' +
      '<div class="couple-right">' +
        (d.acta && d.id && d.photo ? '<span class="badge badge-docs-ok">Completo</span>' : '<span class="badge badge-docs-pend">Pendiente</span>') +
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
  const d = c.docs || {};
  const docItems = [
    { key:'acta', label:'Acta de matrimonio', icon:'📋' },
    { key:'id',   label:'Identificación',     icon:'🪪' },
    { key:'photo',label:'Foto juntos',         icon:'📷' },
  ];
  const docRows = docItems.map(item => {
    const has = d[item.key];
    return '<div class="detail-row">' +
      '<span class="detail-lbl">' + item.icon + ' ' + item.label + '</span>' +
      '<span class="detail-val" style="color:' + (has ? '#1E7B3C' : '#B06000') + '">' + (has ? '✓ Cargado' : '⏳ Pendiente') + '</span>' +
    '</div>';
  }).join('');
  const logHTML = (c.docLog || []).slice(-5).reverse().map(l =>
    '<div class="doc-log-item"><span class="log-time">' + l.ts + '</span> ' + l.user + ' subió ' + l.doc + '</div>'
  ).join('') || '<div style="color:#aaa;font-size:12px;">Sin actividad</div>';

  // Historial de pagos
  let paymentsHTML = '';
  if (payments.length === 0) {
    paymentsHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sin abonos registrados aún.</div>';
  } else {
    let acum = 0;
    paymentsHTML = '<div class="payment-history">' +
      payments.map((p, i) => {
        acum += p.amount || 0;
        return '<div class="payment-item">' +
          '<div class="payment-dot ' + (i === 0 ? 'first' : '') + '"></div>' +
          '<div class="payment-info">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
              '<div class="payment-amount">$' + fmtMoney(p.amount) + '</div>' +
              '<button onclick="deletePayment(\'' + c.id + '\',\'' + p.id + '\')" style="background:none;border:none;color:#ccc;font-size:16px;cursor:pointer;padding:0 0 0 8px;" title="Eliminar abono">✕</button>' +
            '</div>' +
            '<div class="payment-meta">' + formatDate(p.date) + ' · Recibió: ' + (p.receivedBy || '—') + '</div>' +
            (p.note ? '<div class="payment-note">"' + p.note + '"</div>' : '') +
            '<div class="payment-acum">Acumulado: $' + fmtMoney(acum) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  document.getElementById('detail-body').innerHTML =
    '<div class="section-label">Participantes</div>' +
    '<div class="detail-row"><span class="detail-lbl">Él</span><span class="detail-val">' + c.him + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Ella</span><span class="detail-val">' + c.her + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Tel. él</span><span class="detail-val">' + (c.telHim||'—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Tel. ella</span><span class="detail-val">' + (c.telHer||'—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Email él</span><span class="detail-val" style="font-size:12px">' + (c.emailHim||'—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Email ella</span><span class="detail-val" style="font-size:12px">' + (c.emailHer||'—') + '</span></div>' +

    '<div class="section-label mt16">Resumen de pago</div>' +
    '<div class="detail-row"><span class="detail-lbl">Costo total</span><span class="detail-val">$' + fmtMoney(cost) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Total pagado</span><span class="detail-val" style="color:#1E7B3C">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Pendiente</span><span class="detail-val" style="color:' + (pending > 0 ? '#B06000' : '#1E7B3C') + '">' + (pending > 0 ? '$'+fmtMoney(pending) : '✓ Liquidado') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">No. de abonos</span><span class="detail-val">' + payments.length + '</span></div>' +

    '<div class="section-label mt16">Historial de abonos</div>' +
    paymentsHTML +

    '<div class="section-label mt16">Documentos</div>' +
    docRows +

    '<div class="section-label mt16">Log de documentos</div>' +
    '<div>' + logHTML + '</div>' +

    (c.comments ? '<div class="section-label mt16">Comentarios</div><div style="font-size:13px;color:#555;padding:8px 0;">' + c.comments + '</div>' : '') +

    '<div class="section-label mt16">Registro</div>' +
    '<div class="detail-row"><span class="detail-lbl">Fecha registro</span><span class="detail-val">' + formatDate(c.regDate) + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Evento</span><span class="detail-val">' + (c.eventDate||'—') + '</span></div>' +
    '<div class="detail-row"><span class="detail-lbl">Registrado por</span><span class="detail-val">' + (c.createdBy||'—') + '</span></div>';
}

function editCouple() {
  closeModal('modal-detail');
  setTimeout(() => openNewCoupleModal(detailCoupleId), 100);
}

// ===== MODAL DE PAGO =====
function openPaymentModal() {
  const c = couples.find(x => x.id === detailCoupleId);
  if (!c) return;
  const cost = config.cost || 0;
  const totalPaid = getTotalPaid(c);
  const pending = Math.max(0, cost - totalPaid);
  const payments = c.payments || [];
  document.getElementById('pay-info-banner').innerHTML =
    '<div class="pi-name">♡ ' + c.him + ' & ' + c.her + '</div>' +
    '<div class="pi-row"><span class="pi-lbl">Total pagado</span><span class="pi-val green">$' + fmtMoney(totalPaid) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Pendiente</span><span class="pi-val amber">$' + fmtMoney(pending) + '</span></div>' +
    '<div class="pi-row"><span class="pi-lbl">Abonos anteriores</span><span class="pi-val">' + payments.length + '</span></div>';
  document.getElementById('pay-amount').value = '';
  document.getElementById('pay-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('pay-received-by').value = '';
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
  const totalPaid = getTotalPaid(c);
  const newTotal = totalPaid + amount;
  const newPending = Math.max(0, cost - newTotal);
  const preview = document.getElementById('pay-preview');
  preview.innerHTML = 'Nuevo total: <strong>$' + fmtMoney(newTotal) + '</strong> · Pendiente: <strong>$' + fmtMoney(newPending) + '</strong>' + (newPending === 0 ? ' ✓ ¡Liquidado!' : '');
  preview.classList.add('visible');
}

function savePayment() {
  const amount = parseFloat(document.getElementById('pay-amount').value);
  if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
  const date = document.getElementById('pay-date').value;
  const receivedBy = document.getElementById('pay-received-by').value.trim();
  const note = document.getElementById('pay-note').value.trim();
  if (!date) { showToast('Selecciona la fecha del pago', 'error'); return; }
  if (!receivedBy) { showToast('Indica quién recibió el pago', 'error'); return; }
  const idx = couples.findIndex(c => c.id === detailCoupleId);
  if (idx === -1) return;
  if (!couples[idx].payments) couples[idx].payments = [];
  const payment = {
    id: 'P' + Date.now(),
    coupleId: detailCoupleId,
    amount, date, receivedBy, note,
    registeredBy: currentUser.name,
    registeredAt: new Date().toISOString(),
  };
  couples[idx].payments.push(payment);
  couples[idx].amount = couples[idx].payments.reduce((s, p) => s + (p.amount || 0), 0);
  saveToStorage();
  syncPaymentToSheets(payment, couples[idx]);
  closeModal('modal-payment');
  setTimeout(() => { openDetail(detailCoupleId); showToast('Abono registrado', 'success'); }, 200);
  refreshDashboard();
  renderCouples();
  renderPayments();
}

function deletePayment(coupleId, paymentId) {
  if (!confirm('¿Eliminar este abono?')) return;
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

// ===== NUEVO / EDITAR PAREJA =====
function openNewCoupleModal(coupleIdToEdit) {
  editingCoupleId = coupleIdToEdit || null;
  docData = { acta: null, id: null, photo: null };
  ['couple-id','cp-him','cp-her','cp-tel-him','cp-tel-her','cp-email-him','cp-email-her','cp-amount','cp-received-by','cp-comments'].forEach(f => {
    const el = document.getElementById(f);
    if (el) el.value = '';
  });
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
  const cost = config.cost || 0;
  document.getElementById('modal-cost').textContent = '$' + fmtMoney(cost);
  document.getElementById('modal-pending').textContent = '$' + fmtMoney(cost);

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
      // Ocultar sección de pago al editar
      document.getElementById('pay-section').style.display = 'none';
      if (c.docs) {
        ['acta','id','photo'].forEach(k => {
          if (c.docs[k]) {
            document.getElementById('status-' + k).textContent = 'Cargado';
            document.getElementById('status-' + k).classList.add('loaded');
            const uploadEl = document.getElementById('doc-' + k).closest('.doc-upload-item');
            if (uploadEl) uploadEl.classList.add('has-doc');
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

function updatePaymentStatus() {
  const amount = parseFloat(document.getElementById('cp-amount').value) || 0;
  const cost = config.cost || 0;
  const pending = Math.max(0, cost - amount);
  document.getElementById('modal-pending').textContent = '$' + fmtMoney(pending);
}

function triggerUpload(inputId) {
  document.getElementById(inputId).click();
}

function handleDocUpload(type, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    docData[type] = { name: file.name, data: e.target.result, size: file.size };
    document.getElementById('status-' + type).textContent = file.name.length > 15 ? file.name.substring(0,15)+'…' : file.name;
    document.getElementById('status-' + type).classList.add('loaded');
    const uploadEl = input.closest('.doc-upload-item');
    if (uploadEl) uploadEl.classList.add('has-doc');
  };
  reader.readAsDataURL(file);
}

function saveCouple() {
  const him = document.getElementById('cp-him').value.trim();
  const her = document.getElementById('cp-her').value.trim();
  if (!him || !her) { showToast('Ingresa los nombres de ambos', 'error'); return; }
  const btn = document.getElementById('btn-save-couple');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  const now = new Date().toISOString();
  const nowDisplay = now.split('T')[0];
  let couple;
  if (editingCoupleId) {
    const idx = couples.findIndex(c => c.id === editingCoupleId);
    couple = { ...couples[idx] };
    const docLog = couple.docLog || [];
    ['acta','id','photo'].forEach(k => {
      if (docData[k] && (!couple.docs || !couple.docs[k])) {
        docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta: 'acta de matrimonio', id: 'identificación', photo: 'foto' }[k] });
      }
    });
    couple.docLog = docLog;
    couple.him = him;
    couple.her = her;
    couple.telHim = document.getElementById('cp-tel-him').value.trim();
    couple.telHer = document.getElementById('cp-tel-her').value.trim();
    couple.emailHim = document.getElementById('cp-email-him').value.trim();
    couple.emailHer = document.getElementById('cp-email-her').value.trim();
    couple.comments = document.getElementById('cp-comments').value.trim();
    couple.regDate = document.getElementById('cp-reg-date').value;
    couple.docs = { ...couple.docs, ...docData };
    couples[idx] = couple;
  } else {
    const docLog = [];
    ['acta','id','photo'].forEach(k => {
      if (docData[k]) docLog.push({ ts: nowDisplay, user: currentUser.name, doc: { acta: 'acta de matrimonio', id: 'identificación', photo: 'foto' }[k] });
    });
    const initialAmount = parseFloat(document.getElementById('cp-amount').value) || 0;
    const initialReceiver = document.getElementById('cp-received-by').value.trim();
    const initialPayments = [];
    if (initialAmount > 0 && initialReceiver) {
      initialPayments.push({
        id: 'P' + Date.now(),
        coupleId: 'TMP',
        amount: initialAmount,
        date: document.getElementById('cp-reg-date').value,
        receivedBy: initialReceiver,
        note: 'Pago inicial al registrarse',
        registeredBy: currentUser.name,
        registeredAt: now,
      });
    }
    couple = {
      id: 'C' + Date.now(),
      him, her,
      telHim: document.getElementById('cp-tel-him').value.trim(),
      telHer: document.getElementById('cp-tel-her').value.trim(),
      emailHim: document.getElementById('cp-email-him').value.trim(),
      emailHer: document.getElementById('cp-email-her').value.trim(),
      amount: initialAmount,
      receivedBy: initialReceiver,
      payments: initialPayments,
      comments: document.getElementById('cp-comments').value.trim(),
      regDate: document.getElementById('cp-reg-date').value,
      eventDate: document.getElementById('cp-event-date').value,
      docs: { ...docData },
      docLog,
      createdBy: currentUser.name,
      createdAt: now,
    };
    if (couple.payments.length > 0) couple.payments[0].coupleId = couple.id;
    couples.unshift(couple);
  }
  saveToStorage();
  syncToSheets(couple);
  btn.disabled = false;
  btn.textContent = 'Guardar registro';
  closeModal('modal-couple');
  showToast(editingCoupleId ? 'Registro actualizado' : 'Pareja registrada', 'success');
  refreshDashboard();
  renderCouples();
}

// ===== USERS =====
function renderUsers() {
  const el = document.getElementById('users-list');
  el.innerHTML = users.map(u =>
    '<div class="user-item">' +
      '<div class="user-avatar">' + u.name.charAt(0).toUpperCase() + '</div>' +
      '<div class="user-item-info">' +
        '<div class="user-item-name">' + u.name + '</div>' +
        '<div class="user-item-email">' + u.email + '</div>' +
      '</div>' +
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
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) { showToast('Ya existe un usuario con ese correo', 'error'); return; }
  users.push({ id: Date.now(), name, email, password: pass, role });
  saveUsers();
  renderUsers();
  closeModal('modal-user');
  showToast('Usuario agregado', 'success');
}

// ===== GOOGLE SHEETS SYNC =====
async function syncPaymentToSheets(payment, couple) {
  if (!config.scriptUrl) return;
  try {
    const totalPaid = getTotalPaid(couple);
    const cost = config.cost || 0;
    const pending = Math.max(0, cost - totalPaid);
    let payStatus = 'Sin pago';
    if (cost > 0 && totalPaid >= cost) payStatus = 'Pagado';
    else if (totalPaid > 0) payStatus = 'Parcial';
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'savePayment', payment, coupleUpdate: { id: couple.id, totalPaid, pending, payStatus, numPayments: couple.payments.length } })
    });
  } catch (e) { console.warn('Payment sync error:', e); }
}

async function syncToSheets(couple) {
  if (!config.scriptUrl) return;
  try {
    const totalPaid = getTotalPaid(couple);
    await fetch(config.scriptUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'saveCouple',
        couple: {
          id: couple.id, him: couple.him, her: couple.her,
          telHim: couple.telHim, telHer: couple.telHer,
          emailHim: couple.emailHim, emailHer: couple.emailHer,
          amount: totalPaid, receivedBy: couple.receivedBy,
          comments: couple.comments, regDate: couple.regDate, eventDate: couple.eventDate,
          docsActa: couple.docs?.acta ? 'Sí' : 'No',
          docsId: couple.docs?.id ? 'Sí' : 'No',
          docsPhoto: couple.docs?.photo ? 'Sí' : 'No',
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
        const existing = couples.find(c => c.id === sc.id);
        if (!existing) couples.push({ ...sc, docs: {}, docLog: [], payments: [] });
      });
      saveToStorage();
      refreshDashboard();
    }
  } catch (e) { console.warn('Sheets read error:', e); }
}

async function testConnection() {
  const btn = document.querySelector('[onclick="testConnection()"]');
  const statusEl = document.getElementById('conn-status');
  btn.textContent = 'Probando...';
  btn.disabled = true;
  if (!config.scriptUrl) {
    statusEl.innerHTML = '<span class="dot red"></span> Sin URL configurada';
    btn.textContent = 'Probar conexión'; btn.disabled = false; return;
  }
  try {
    const res = await fetch(config.scriptUrl + '?action=ping', { mode: 'cors' });
    statusEl.innerHTML = res.ok
      ? '<span class="dot green"></span> Conectado a Google Sheets'
      : '<span class="dot amber"></span> Respuesta inesperada del script';
  } catch (e) {
    statusEl.innerHTML = '<span class="dot red"></span> No se pudo conectar — verifica la URL';
  }
  btn.textContent = 'Probar conexión'; btn.disabled = false;
}

// ===== MODALES =====
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
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

// ===== UTILIDADES =====
function fmtMoney(n) {
  return (parseFloat(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return parseInt(parts[2]) + ' ' + months[parseInt(parts[1])-1] + ' ' + parts[0];
}
