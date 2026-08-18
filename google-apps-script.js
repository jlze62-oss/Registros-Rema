// ============================================================
// REGISTRO MATRIMONIAL — Google Apps Script v2
// Soporta sincronización masiva de parejas, pagos y usuarios
// ============================================================

const SHEET_NAME_COUPLES  = 'Parejas';
const SHEET_NAME_PAYMENTS = 'Pagos';
const SHEET_NAME_CONFIG   = 'Configuracion';
const SHEET_NAME_USERS    = 'Usuarios';
const SHEET_NAME_LOG      = 'Log_Actividad';

// ===== PUNTO DE ENTRADA GET =====
function doGet(e) {
  const action = e.parameter.action || '';
  if (action === 'ping') return jsonResponse({ ok: true, msg: 'REMA conectado ✓' });
  if (action === 'getCouples') return jsonResponse(getCouples());
  if (action === 'getConfig') return jsonResponse(getConfig());
  return jsonResponse({ ok: false, msg: 'Acción no reconocida' });
}

// ===== PUNTO DE ENTRADA POST =====
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action || '';
    if (action === 'saveCouple')    return jsonResponse(saveCouple(payload.couple));
    if (action === 'savePayment')   return jsonResponse(savePayment(payload.payment, payload.coupleUpdate));
    if (action === 'deleteCouple')  return jsonResponse(deleteCouple(payload.id));
    if (action === 'saveConfig')    return jsonResponse(saveConfigData(payload.config));
    if (action === 'syncAll')       return jsonResponse(syncAll(payload));
    if (action === 'syncPayments')  return jsonResponse(syncPayments(payload.payments));
    if (action === 'syncUsers')     return jsonResponse(syncUsers(payload.users));
    return jsonResponse({ ok: false, msg: 'Acción no reconocida' });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

// ===== HELPER =====
function jsonResponse(data) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground('#7C2D3E').setFontColor('#FFFFFF').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

// ===== HEADERS =====
const COUPLE_HEADERS = [
  'No.', 'ID', 'Él', 'Ella', 'Tel. Él', 'Tel. Ella', 'Email Él', 'Email Ella',
  'Pagado ($)', 'Pendiente ($)', 'Recibió pago',
  'Fecha Evento', 'Fecha Registro',
  'Acta Matrimonio', 'Identificación', 'Foto Juntos',
  'Estado Pago', 'Estado Docs', 'Comentarios',
  'Beca', 'Penalización', 'Cancelación',
  'Registrado por', 'Fecha Creación'
];

const PAYMENT_HEADERS = [
  'ID Pago', 'ID Pareja', 'Él', 'Ella',
  'Monto ($)', 'Tipo', 'Fecha Pago', 'Recibió', 'Forma de Pago', 'Nota',
  'Registrado por', 'Fecha Registro'
];

const USER_HEADERS = ['ID', 'Nombre', 'Usuario', 'Rol', 'Activo'];

// ===== SINCRONIZACIÓN MASIVA =====
function syncAll(payload) {
  const couples  = payload.couples  || [];
  const payments = payload.payments || [];
  const users    = payload.users    || [];
  const cfg      = payload.config   || {};

  let results = { couples: 0, payments: 0, users: 0 };

  // 1. Parejas — limpiar y reescribir todo
  const cSheet = getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  if (cSheet.getLastRow() > 1) cSheet.getRange(2, 1, cSheet.getLastRow() - 1, COUPLE_HEADERS.length).clearContent();

  if (couples.length > 0) {
    const cost = parseFloat(cfg.cost) || 0;
    const rows = couples.map((c, i) => {
      const paid = parseFloat(c.amount) || 0;
      const pending = Math.max(0, cost - paid);
      let payStatus = 'Sin pago';
      if (cost > 0 && paid >= cost) payStatus = 'Pagado';
      else if (paid > 0) payStatus = 'Parcial';
      if (c.cancelacion) payStatus = 'Cancelada';
      const docsOk = c.docs && c.docs.acta && c.docs.id && c.docs.photo;
      return [
        i + 1,  // No. consecutivo
        c.id || '', c.him || '', c.her || '',
        c.telHim || '', c.telHer || '',
        c.emailHim || '', c.emailHer || '',
        paid, pending, c.receivedBy || '',
        c.eventDate || '', c.regDate || '',
        (c.docs && c.docs.acta) ? 'Sí' : 'No',
        (c.docs && c.docs.id)   ? 'Sí' : 'No',
        (c.docs && c.docs.photo)? 'Sí' : 'No',
        payStatus,
        docsOk ? 'Completo' : 'Pendiente',
        c.comments || '',
        c.beca ? 'Sí ($' + c.beca.amount + ')' : 'No',
        c.penalizacion ? 'Sí ($' + c.penalizacion.amount + ')' : 'No',
        c.cancelacion ? (c.cancelacion.type === 'credito' ? 'Crédito' : 'Cancelada') : 'No',
        c.createdBy || '', c.createdAt || ''
      ];
    });
    cSheet.getRange(2, 1, rows.length, COUPLE_HEADERS.length).setValues(rows);

    // Formato de colores por estado
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const payStatus = row[15];
      const range = cSheet.getRange(rowNum, 1, 1, COUPLE_HEADERS.length);
      if (payStatus === 'Pagado')   range.setBackground('#EAF7EE');
      else if (payStatus === 'Parcial')  range.setBackground('#FFF4E5');
      else if (payStatus === 'Cancelada') range.setBackground('#F5F5F5');
      else range.setBackground('#FCEEF0');
    });
    results.couples = rows.length;
  }

  // 2. Pagos — limpiar y reescribir
  const pSheet = getOrCreateSheet(SHEET_NAME_PAYMENTS, PAYMENT_HEADERS);
  if (pSheet.getLastRow() > 1) pSheet.getRange(2, 1, pSheet.getLastRow() - 1, PAYMENT_HEADERS.length).clearContent();

  if (payments.length > 0) {
    const pRows = payments.map(p => [
      p.id || '', p.coupleId || '', p.him || '', p.her || '',
      p.amount || 0,
      p.amount < 0 ? (p.method === 'penalizacion' ? 'Penalización' : p.method === 'cancelacion' ? 'Cancelación' : 'Descuento') : (p.method === 'beca' ? 'Beca' : 'Abono'),
      p.date || '', p.receivedBy || '',
      p.method === 'transferencia' ? 'Transferencia' : p.method === 'beca' ? 'Beca REMA' : p.method === 'penalizacion' ? 'Penalización' : p.method === 'cancelacion' ? 'Cancelación' : 'Efectivo',
      p.note || '', p.registeredBy || '', p.registeredAt || ''
    ]);
    pSheet.getRange(2, 1, pRows.length, PAYMENT_HEADERS.length).setValues(pRows);

    // Colores: negativos en rojo claro, positivos en verde claro
    pRows.forEach((row, i) => {
      const rowNum = i + 2;
      const amount = row[4];
      pSheet.getRange(rowNum, 1, 1, PAYMENT_HEADERS.length)
        .setBackground(amount < 0 ? '#FCEEF0' : amount === 0 ? '#F5F5F5' : '#EAF7EE');
    });
    results.payments = pRows.length;
  }

  // 3. Usuarios — solo nombre, usuario y rol (sin contraseñas)
  const uSheet = getOrCreateSheet(SHEET_NAME_USERS, USER_HEADERS);
  if (uSheet.getLastRow() > 1) uSheet.getRange(2, 1, uSheet.getLastRow() - 1, USER_HEADERS.length).clearContent();
  if (users.length > 0) {
    const uRows = users.map(u => [u.id || '', u.name || '', u.email || '', u.role || '', 'Sí']);
    uSheet.getRange(2, 1, uRows.length, USER_HEADERS.length).setValues(uRows);
    results.users = uRows.length;
  }

  // 4. Configuración
  if (Object.keys(cfg).length > 0) saveConfigData(cfg);

  logActivity('Sincronización masiva: ' + results.couples + ' parejas, ' + results.payments + ' pagos, ' + results.users + ' usuarios');
  return { ok: true, results };
}

// ===== SINCRONIZAR PAGOS (limpia y reescribe) =====
function syncPayments(payments) {
  if (!payments || payments.length === 0) return { ok: true, count: 0 };
  const sheet = getOrCreateSheet(SHEET_NAME_PAYMENTS, PAYMENT_HEADERS);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, PAYMENT_HEADERS.length).clearContent();
  }
  const rows = payments.map(p => [
    p.id || '', p.coupleId || '', p.him || '', p.her || '',
    p.amount || 0,
    p.amount < 0 ? (p.method === 'penalizacion' ? 'Penalización' : p.method === 'cancelacion' ? 'Cancelación' : 'Descuento') : (p.method === 'beca' ? 'Beca' : 'Abono'),
    p.date || '', p.receivedBy || '',
    p.method === 'transferencia' ? 'Transferencia' : p.method === 'beca' ? 'Beca REMA' : p.method === 'penalizacion' ? 'Penalización' : p.method === 'cancelacion' ? 'Cancelación' : 'Efectivo',
    p.note || '', p.registeredBy || '', p.registeredAt || ''
  ]);
  sheet.getRange(2, 1, rows.length, PAYMENT_HEADERS.length).setValues(rows);
  rows.forEach((row, i) => {
    const amount = row[4];
    sheet.getRange(i + 2, 1, 1, PAYMENT_HEADERS.length)
      .setBackground(amount < 0 ? '#FCEEF0' : '#EAF7EE');
  });
  logActivity('Sincronización de pagos: ' + rows.length + ' registros');
  return { ok: true, count: rows.length };
}

// ===== SINCRONIZAR USUARIOS =====
function syncUsers(users) {
  if (!users || users.length === 0) return { ok: true, count: 0 };
  const sheet = getOrCreateSheet(SHEET_NAME_USERS, USER_HEADERS);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, USER_HEADERS.length).clearContent();
  }
  const rows = users.map(u => [u.id || '', u.name || '', u.email || '', u.role || '', 'Sí']);
  sheet.getRange(2, 1, rows.length, USER_HEADERS.length).setValues(rows);
  logActivity('Sincronización de usuarios: ' + rows.length + ' registros');
  return { ok: true, count: rows.length };
}

// ===== GUARDAR / ACTUALIZAR PAREJA (individual) =====
function saveCouple(c) {
  const sheet = getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  const cfg = getConfig();
  const cost = parseFloat(cfg.cost) || 0;
  const paid = parseFloat(c.amount) || 0;
  const pending = Math.max(0, cost - paid);
  let payStatus = 'Sin pago';
  if (cost > 0 && paid >= cost) payStatus = 'Pagado';
  else if (paid > 0) payStatus = 'Parcial';

  const row = [
    c.num || '', c.id, c.him, c.her, c.telHim || '', c.telHer || '',
    c.emailHim || '', c.emailHer || '',
    paid, pending, c.receivedBy || '',
    c.eventDate || '', c.regDate || '',
    c.docsActa || 'No', c.docsId || 'No', c.docsPhoto || 'No',
    payStatus, 'Pendiente', c.comments || '',
    'No', 'No', 'No',
    c.createdBy || '', c.createdAt || new Date().toISOString()
  ];

  const data = sheet.getDataRange().getValues();
  const hasNoCol = data[0] && data[0][0] === 'No.';
  const idCol = hasNoCol ? 1 : 0;

  // Buscar por ID en la columna correcta
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === c.id) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      applyRowFormatting(sheet, i + 1, payStatus);
      logActivity('Actualización: ' + c.him + ' & ' + c.her);
      return { ok: true, action: 'updated' };
    }
  }
  const newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, row.length).setValues([row]);
  applyRowFormatting(sheet, newRow, payStatus);
  logActivity('Nuevo registro: ' + c.him + ' & ' + c.her);
  return { ok: true, action: 'inserted' };
}

function applyRowFormatting(sheet, rowNum, payStatus) {
  const range = sheet.getRange(rowNum, 1, 1, COUPLE_HEADERS.length);
  if (payStatus === 'Pagado')      range.setBackground('#EAF7EE');
  else if (payStatus === 'Parcial') range.setBackground('#FFF4E5');
  else                              range.setBackground('#FCEEF0');
}

// ===== GUARDAR ABONO (individual) =====
function savePayment(payment, coupleUpdate) {
  const paySheet = getOrCreateSheet(SHEET_NAME_PAYMENTS, PAYMENT_HEADERS);
  const couplesSheet = getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  const cData = couplesSheet.getDataRange().getValues();

  let himName = '', herName = '';
  for (let i = 1; i < cData.length; i++) {
    if (cData[i][0] === payment.coupleId) { himName = cData[i][1]; herName = cData[i][2]; break; }
  }

  paySheet.appendRow([
    payment.id, payment.coupleId, himName, herName,
    payment.amount,
    payment.amount < 0 ? 'Descuento/Penalización' : 'Abono',
    payment.date, payment.receivedBy || '',
    payment.method === 'transferencia' ? 'Transferencia' : 'Efectivo',
    payment.note || '', payment.registeredBy || '', payment.registeredAt || ''
  ]);

  if (coupleUpdate) {
    for (let i = 1; i < cData.length; i++) {
      if (cData[i][0] === coupleUpdate.id) {
        couplesSheet.getRange(i + 1, 8).setValue(coupleUpdate.totalPaid);
        couplesSheet.getRange(i + 1, 9).setValue(coupleUpdate.pending);
        couplesSheet.getRange(i + 1, 16).setValue(coupleUpdate.payStatus);
        applyRowFormatting(couplesSheet, i + 1, coupleUpdate.payStatus);
        break;
      }
    }
  }
  logActivity('Abono: $' + payment.amount + ' — Pareja ' + payment.coupleId);
  return { ok: true };
}

// ===== OBTENER PAREJAS =====
function getCouples() {
  const sheet = getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, couples: [] };

  // Detectar si la primera columna es "No." o "ID"
  const hasNoCol = data[0][0] === 'No.';
  const offset = hasNoCol ? 1 : 0; // desplazamiento de columnas

  // Obtener todos los pagos agrupados por pareja
  const paySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_PAYMENTS);
  const paymentsByCouple = {};
  if (paySheet && paySheet.getLastRow() > 1) {
    const pData = paySheet.getDataRange().getValues();
    pData.slice(1).filter(r => r[0]).forEach(r => {
      const coupleId = r[1];
      if (!paymentsByCouple[coupleId]) paymentsByCouple[coupleId] = [];
      paymentsByCouple[coupleId].push({
        id: r[0], coupleId: r[1],
        amount: parseFloat(r[4]) || 0,
        date: r[6] ? String(r[6]).split('T')[0].split(' ')[0] : '',
        receivedBy: r[7] || '',
        method: r[8] === 'Transferencia' ? 'transferencia' : r[8] === 'Beca REMA' ? 'beca' : r[8] === 'Penalización' ? 'penalizacion' : r[8] === 'Cancelación' ? 'cancelacion' : 'efectivo',
        note: r[9] || '',
        registeredBy: r[10] || '',
        registeredAt: r[11] || '',
      });
    });
  }

  const couples = data.slice(1).filter(row => row[offset]).map(row => ({
    id:       row[offset + 0],
    him:      row[offset + 1],
    her:      row[offset + 2],
    telHim:   row[offset + 3],
    telHer:   row[offset + 4],
    emailHim: row[offset + 5],
    emailHer: row[offset + 6],
    amount:   parseFloat(row[offset + 7]) || 0,
    eventDate: row[offset + 10] || '',
    regDate:  row[offset + 11] ? String(row[offset + 11]).split('T')[0] : '',
    comments: row[offset + 17] || '',
    createdBy: row[offset + 21] || '',
    createdAt: row[offset + 22] || '',
    docs: {
      acta:  row[offset + 12] === 'Sí' ? true : null,
      id:    row[offset + 13] === 'Sí' ? true : null,
      photo: row[offset + 14] === 'Sí' ? true : null,
    },
    payments: paymentsByCouple[row[offset + 0]] || [],
  }));

  return { ok: true, couples };
}

// ===== ELIMINAR PAREJA =====
function deleteCouple(id) {
  const sheet = getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) { sheet.deleteRow(i + 1); logActivity('Eliminado: ID ' + id); return { ok: true }; }
  }
  return { ok: false, msg: 'No encontrado' };
}

// ===== CONFIGURACIÓN =====
function getConfig() {
  const sheet = getOrCreateSheet(SHEET_NAME_CONFIG, ['Clave', 'Valor']);
  const data = sheet.getDataRange().getValues();
  const cfg = {};
  for (let i = 1; i < data.length; i++) cfg[data[i][0]] = data[i][1];
  return cfg;
}

function saveConfigData(config) {
  const sheet = getOrCreateSheet(SHEET_NAME_CONFIG, ['Clave', 'Valor']);
  const entries = Object.entries(config);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();
  if (entries.length > 0) sheet.getRange(2, 1, entries.length, 2).setValues(entries);
  return { ok: true };
}

// ===== LOG =====
function logActivity(msg) {
  const sheet = getOrCreateSheet(SHEET_NAME_LOG, ['Fecha/Hora', 'Actividad']);
  sheet.appendRow([new Date().toLocaleString('es-MX'), msg]);
}

// ===== SETUP INICIAL =====
// Ejecutar esta función UNA VEZ manualmente para inicializar las hojas
function setupSheets() {
  getOrCreateSheet(SHEET_NAME_COUPLES, COUPLE_HEADERS);
  getOrCreateSheet(SHEET_NAME_PAYMENTS, PAYMENT_HEADERS);
  getOrCreateSheet(SHEET_NAME_CONFIG, ['Clave', 'Valor']);
  getOrCreateSheet(SHEET_NAME_USERS, USER_HEADERS);
  getOrCreateSheet(SHEET_NAME_LOG, ['Fecha/Hora', 'Actividad']);

  const cfgSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_CONFIG);
  cfgSheet.getRange(2, 1, 4, 2).setValues([
    ['eventName', 'REMA 31 oct – 1 nov 2026'],
    ['dateStart', '2026-10-31'],
    ['dateEnd',   '2026-11-01'],
    ['cost',      '2698'],
  ]);

  Logger.log('✅ Hojas creadas correctamente.');
}
