// ============================================================
//  begom-api — Worker для лендинга «Бегом во двор»
//  Фаза 2: расписание (материализация из шаблонов) + чтение с остатком мест.
//  Дальше: запись/резерв, оплата Т-Банк, уведомления TG+VK.
// ============================================================

const HORIZON_DAYS = 28;     // на сколько вперёд генерируем занятия из шаблонов
const MSK = '+03:00';        // МСК без перехода на летнее время

// ---------- утилиты ----------
const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-key',
});
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors() },
  });

const nowIso = () => new Date().toISOString();
const mskTodayStr = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// ISO день недели: 1=пн … 7=вс
function isoWeekday(dateStr) {
  const wd = new Date(`${dateStr}T12:00:00${MSK}`).getUTCDay(); // 0=вс..6=сб
  return ((wd + 6) % 7) + 1;
}
// дата (МСК) + 'HH:MM' (МСК) -> UTC ISO
const mskToUtcIso = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00${MSK}`).toISOString();

// ---------- материализация занятий из шаблонов ----------
async function materialize(db) {
  const { results: templates } = await db
    .prepare(`SELECT * FROM session_templates WHERE active=1`).all();
  if (!templates.length) return 0;

  const start = mskTodayStr();
  const nowI = nowIso();
  const stmts = [];
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const dateStr = addDaysStr(start, i);
    const wd = isoWeekday(dateStr);
    for (const t of templates) {
      if (t.weekday !== wd) continue;
      if (t.valid_from && dateStr < t.valid_from) continue;
      if (t.valid_until && dateStr > t.valid_until) continue;
      const startsAt = mskToUtcIso(dateStr, t.time_msk);
      if (startsAt < nowI) continue; // прошедшие слоты не создаём
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO sessions
           (location_id, instructor_id, template_id, kind, starts_at, duration_min, age_group, capacity, price_kopecks)
         VALUES (?, ?, ?, 'regular', ?, ?, ?, ?, ?)`
      ).bind(t.location_id, t.instructor_id, t.id, startsAt,
             t.duration_min, t.age_group, t.capacity, t.price_kopecks));
    }
  }
  if (!stmts.length) return 0;
  await db.batch(stmts);
  return stmts.length;
}

// Примирение занятий с шаблонами: закрыть будущие занятия отключённых шаблонов,
// вернуть занятия снова включённых, синхронизировать вместимость/цену.
async function reconcile(db) {
  const nowI = nowIso();
  // 1) закрыть будущие занятия отключённых шаблонов (кроме тех, где есть брони)
  await db.prepare(
    `UPDATE sessions SET status='closed'
      WHERE status='open' AND starts_at>=?1 AND template_id IS NOT NULL
        AND template_id IN (SELECT id FROM session_templates WHERE active=0)
        AND id NOT IN (SELECT session_id FROM bookings WHERE status IN ('paid','attended','hold'))`
  ).bind(nowI).run();
  // 2) вернуть будущие авто-закрытые занятия снова включённых шаблонов
  await db.prepare(
    `UPDATE sessions SET status='open'
      WHERE status='closed' AND starts_at>=?1 AND template_id IS NOT NULL
        AND template_id IN (SELECT id FROM session_templates WHERE active=1)`
  ).bind(nowI).run();
  // 3) синхронизировать вместимость/цену будущих занятий с их шаблоном
  await db.prepare(
    `UPDATE sessions SET
       capacity=(SELECT capacity FROM session_templates t WHERE t.id=sessions.template_id),
       price_kopecks=(SELECT price_kopecks FROM session_templates t WHERE t.id=sessions.template_id)
      WHERE status='open' AND starts_at>=?1 AND template_id IS NOT NULL
        AND template_id IN (SELECT id FROM session_templates WHERE active=1)`
  ).bind(nowI).run();
}
async function syncSchedule(db) {
  const made = await materialize(db);
  await reconcile(db);
  return made;
}

// ---------- чтение расписания с остатком мест ----------
async function getSchedule(db) {
  const nowI = nowIso();
  const { results: locations } = await db.prepare(
    `SELECT id, title, district, yard_type, access_note, surface
       FROM locations WHERE active=1 ORDER BY sort, id`
  ).all();
  const { results: sessions } = await db.prepare(
    `SELECT s.id, s.location_id, s.kind, s.starts_at, s.duration_min,
            s.age_group, s.capacity, s.price_kopecks,
            (s.capacity - (
               SELECT count(*) FROM bookings b
               WHERE b.session_id = s.id
                 AND (b.status IN ('paid','attended')
                      OR (b.status='hold' AND b.hold_expires_at > ?1))
            )) AS free
       FROM sessions s
      WHERE s.status='open' AND s.starts_at >= ?1
      ORDER BY s.starts_at`
  ).bind(nowI).all();
  return { now: nowI, locations, sessions };
}

// ---------- запись ----------
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return '+' + d;
}
// российский мобильный: нормализованный вид +7 9XXXXXXXXX (11 цифр, вторая — 9)
function validPhone(v) {
  return /^\+79\d{9}$/.test(normPhone(v));
}

async function upsertClient(db, { phone, name, consent, consent_marketing, source }) {
  const norm = normPhone(phone);
  const c = consent ? 1 : 0;                 // общее согласие покрывает ПД + оферту/соглашение
  const cm = consent_marketing ? 1 : 0;
  const ex = await db.prepare(`SELECT id FROM clients WHERE phone=?`).bind(norm).first();
  if (ex) {
    await db.prepare(
      `UPDATE clients SET name=COALESCE(?,name), consent_pd=?, consent_offer=?, consent_marketing=? WHERE id=?`
    ).bind(name || null, c, c, cm, ex.id).run();
    return ex.id;
  }
  const ins = await db.prepare(
    `INSERT INTO clients (phone,name,consent_pd,consent_offer,consent_marketing,source) VALUES (?,?,?,?,?,?)`
  ).bind(norm, name || null, c, c, cm, source || 'web').run();
  return ins.meta.last_row_id;
}

// ---------- Т-Банк (Т-Касса) эквайринг ----------
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Токен = SHA256 от значений корневых скалярных полей + Password, отсортированных по ключу.
async function tbankToken(params, password) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object');
  entries.push(['Password', password]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const concat = entries
    .map(([, v]) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)))
    .join('');
  return sha256hex(concat);
}
async function tbankInit(env, { orderId, amount, description, phone, email }) {
  const root = {
    TerminalKey: env.TBANK_TERMINAL,
    Amount: amount,
    OrderId: orderId,
    Description: description,
    NotificationURL: env.API_URL + '/api/payment/notify',
    SuccessURL: env.SITE_URL + '/?payment=success#booking',
    FailURL: env.SITE_URL + '/?payment=fail#booking',
  };
  const Token = await tbankToken(root, env.TBANK_PASSWORD);
  const reqBody = {
    ...root, Token,
    Receipt: {
      Taxation: env.TAXATION || 'usn_income',
      Phone: phone,
      ...(email ? { Email: email } : {}),
      Items: [{
        Name: description.slice(0, 128),
        Price: amount, Quantity: 1, Amount: amount,
        Tax: 'none', PaymentMethod: 'full_payment', PaymentObject: 'service',
      }],
    },
  };
  const r = await fetch('https://securepay.tinkoff.ru/v2/Init', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody),
  });
  return r.json();
}

async function book(env, body) {
  const db = env.DB;
  const b = body || {};
  if (!b.session_id || !b.parent_name || !b.phone || !b.child_name)
    return json({ error: 'missing_fields' }, 400);
  if (!b.consent)
    return json({ error: 'consent_required' }, 400);
  if (!validPhone(b.phone))               // +7 9XXXXXXXXX
    return json({ error: 'bad_phone' }, 400);

  const s = await db.prepare(`SELECT * FROM sessions WHERE id=?`).bind(b.session_id).first();
  if (!s || s.status !== 'open') return json({ error: 'session_unavailable' }, 404);
  const nowI = nowIso();
  if (s.starts_at < nowI) return json({ error: 'session_past' }, 409);

  const clientId = await upsertClient(db, {
    phone: b.phone, name: b.parent_name, consent: b.consent, consent_marketing: b.consent_marketing,
  });

  // Бесплатное (пробное): атомарный резерв → сразу 'paid'.
  if (s.price_kopecks === 0) {
    const res = await db.prepare(
      `INSERT INTO bookings (session_id, client_id, child_name, child_age, status, amount_kopecks, paid_with, source, paid_at)
       SELECT ?1, ?2, ?3, ?4, 'paid', 0, 'free', 'web', ?5
       WHERE (SELECT count(*) FROM bookings bb WHERE bb.session_id=?1
                AND (bb.status IN ('paid','attended') OR (bb.status='hold' AND bb.hold_expires_at > ?5)))
             < (SELECT capacity FROM sessions WHERE id=?1)`
    ).bind(b.session_id, clientId, b.child_name, b.child_age || null, nowI).run();
    if (!res.meta.changes) return json({ error: 'no_seats' }, 409);
    await notifyBooking(env, db, res.meta.last_row_id); // уведомление — запись на пробное
    return json({ ok: true, status: 'registered', booking_id: res.meta.last_row_id });
  }

  // Платное (регулярное): резерв 'hold' на HOLD_MINUTES → платёж Т-Банка.
  const holdMin = Number(env.HOLD_MINUTES || 15);
  const holdExp = new Date(Date.now() + holdMin * 60000).toISOString();
  const res = await db.prepare(
    `INSERT INTO bookings (session_id, client_id, child_name, child_age, status, amount_kopecks, hold_expires_at, paid_with, source)
     SELECT ?1, ?2, ?3, ?4, 'hold', ?6, ?7, 'tbank', 'web'
     WHERE (SELECT count(*) FROM bookings bb WHERE bb.session_id=?1
              AND (bb.status IN ('paid','attended') OR (bb.status='hold' AND bb.hold_expires_at > ?5)))
           < (SELECT capacity FROM sessions WHERE id=?1)`
  ).bind(b.session_id, clientId, b.child_name, b.child_age || null, nowI, s.price_kopecks, holdExp).run();
  if (!res.meta.changes) return json({ error: 'no_seats' }, 409);
  const bookingId = res.meta.last_row_id;

  if (!env.TBANK_TERMINAL || !env.TBANK_PASSWORD) {
    return json({ ok: false, error: 'payment_not_configured', message: 'Оплата ещё настраивается.' }, 501);
  }

  const orderId = bookingId + '-' + Date.now().toString(36);
  await db.prepare(
    `INSERT INTO payments (booking_id, provider, order_id, amount_kopecks, status) VALUES (?,?,?,?,'new')`
  ).bind(bookingId, 'tbank', orderId, s.price_kopecks).run();

  const desc = 'Занятие «Бегом во двор» — ' + s.age_group + ' лет';
  let init;
  try {
    init = await tbankInit(env, { orderId, amount: s.price_kopecks, description: desc, phone: normPhone(b.phone) });
  } catch (e) {
    init = { Success: false, Message: String((e && e.message) || e) };
  }
  if (init && init.Success && init.PaymentURL) {
    await db.prepare(`UPDATE payments SET provider_payment_id=?, payment_url=?, raw=? WHERE order_id=?`)
      .bind(String(init.PaymentId), init.PaymentURL, JSON.stringify(init), orderId).run();
    return json({ ok: true, status: 'payment', payment_url: init.PaymentURL, booking_id: bookingId });
  }
  // Init не удался — освобождаем место.
  await db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).bind(bookingId).run();
  await db.prepare(`UPDATE payments SET status='rejected', raw=? WHERE order_id=?`)
    .bind(JSON.stringify(init || {}), orderId).run();
  return json({ ok: false, error: 'init_failed', message: (init && (init.Message || init.Details)) || 'Не удалось создать платёж.' }, 502);
}

// Webhook Т-Банка: подтверждение оплаты / возврат.
async function paymentNotify(env, body) {
  const db = env.DB;
  if (!body) return new Response('NO BODY', { status: 400 });
  const recv = { ...body };
  const token = recv.Token; delete recv.Token;
  const calc = await tbankToken(recv, env.TBANK_PASSWORD);
  if (calc !== token) return new Response('BAD TOKEN', { status: 400 });

  const pay = await db.prepare(`SELECT * FROM payments WHERE order_id=?`).bind(String(body.OrderId)).first();
  if (!pay) return new Response('OK');

  const status = body.Status;
  const nowI = nowIso();
  await db.prepare(`UPDATE payments SET status=?, provider_payment_id=?, raw=? WHERE id=?`)
    .bind(status, String(body.PaymentId || pay.provider_payment_id || ''), JSON.stringify(body), pay.id).run();

  if (status === 'CONFIRMED') {
    await db.prepare(`UPDATE payments SET confirmed_at=? WHERE id=?`).bind(nowI, pay.id).run();
    await db.prepare(`UPDATE bookings SET status='paid', paid_with='tbank', paid_at=? WHERE id=? AND status<>'paid'`)
      .bind(nowI, pay.booking_id).run();
    await notifyBooking(env, db, pay.booking_id); // уведомление в TG/ВК — оплачено
  } else if (['REJECTED', 'REFUNDED', 'REVERSED', 'PARTIAL_REFUNDED'].includes(status)) {
    await db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).bind(pay.booking_id).run();
  }
  return new Response('OK');
}

// ---------- уведомления (TG + ВК), только подтверждённые брони ----------
async function buildBookingInfo(db, bookingId) {
  return db.prepare(
    `SELECT b.id, b.child_name, b.child_age, b.amount_kopecks,
            s.starts_at, s.age_group, s.kind,
            l.title AS loc_title,
            c.name AS parent_name, c.phone
       FROM bookings b
       JOIN sessions s ON s.id=b.session_id
       JOIN locations l ON l.id=s.location_id
       JOIN clients c ON c.id=b.client_id
      WHERE b.id=?`
  ).bind(bookingId).first().catch(() => null);
}
function composeBookingText(info) {
  const dt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(info.starts_at));
  const pay = info.amount_kopecks > 0 ? ('оплачено ' + info.amount_kopecks / 100 + ' ₽') : 'пробное (бесплатно)';
  const child = (info.child_name || '') + (info.child_age ? (', ' + info.child_age + ' лет') : '');
  return [
    '🟢 Новая запись — ' + pay,
    '🏠 ' + info.loc_title,
    '🗓 ' + dt + ' (МСК) · группа ' + info.age_group,
    '👶 ' + child,
    '👤 ' + (info.parent_name || ''),
    '📞 ' + (info.phone || ''),
  ].join('\n');
}
async function sendTelegram(env, text) {
  return fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
}
async function sendVK(env, text) {
  const p = new URLSearchParams({
    access_token: env.VK_TOKEN, peer_id: env.VK_PEER, message: text,
    random_id: String(Date.now() % 2147483647), v: '5.199',
  });
  return fetch('https://api.vk.com/method/messages.send', { method: 'POST', body: p });
}
async function notifyBooking(env, db, bookingId) {
  try {
    const info = await buildBookingInfo(db, bookingId);
    if (!info) return;
    const text = composeBookingText(info);
    const tasks = [];
    if (env.TG_TOKEN && env.TG_CHAT_ID) tasks.push(sendTelegram(env, text));
    if (env.VK_TOKEN && env.VK_PEER) tasks.push(sendVK(env, text));
    await Promise.allSettled(tasks);
  } catch (_) { /* уведомление не должно ломать основной флоу */ }
}

// ---------- админка ----------
function adminAuth(req, env) {
  const key = req.headers.get('x-admin-key') || '';
  return !!env.ADMIN_PASSWORD && key === env.ADMIN_PASSWORD;
}
// Белый список таблиц/колонок для безопасного upsert.
const ADMIN_TABLES = {
  locations: ['id', 'title', 'address', 'district', 'yard_type', 'access_note', 'surface', 'active', 'sort'],
  instructors: ['id', 'name', 'experience', 'photo_url', 'pay_rate_kopecks', 'active', 'sort'],
  session_templates: ['id', 'location_id', 'instructor_id', 'weekday', 'time_msk', 'duration_min', 'age_group', 'capacity', 'price_kopecks', 'valid_from', 'valid_until', 'active'],
  sessions: ['id', 'location_id', 'instructor_id', 'template_id', 'kind', 'starts_at', 'duration_min', 'age_group', 'capacity', 'price_kopecks', 'status'],
};
async function adminUpsert(db, table, row) {
  const cols = ADMIN_TABLES[table];
  if (!cols) throw new Error('bad table');
  const data = {};
  for (const c of cols) if (c in row && row[c] !== undefined) data[c] = row[c];
  const keys = Object.keys(data).filter((k) => k !== 'id');
  if (row.id) {
    const sql = `UPDATE ${table} SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`;
    await db.prepare(sql).bind(...keys.map((k) => data[k]), row.id).run();
    return row.id;
  }
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const r = await db.prepare(sql).bind(...keys.map((k) => data[k])).run();
  return r.meta.last_row_id;
}
async function adminData(db) {
  const nowI = nowIso();
  const locations = (await db.prepare(`SELECT * FROM locations ORDER BY sort,id`).all()).results;
  const instructors = (await db.prepare(`SELECT * FROM instructors ORDER BY sort,id`).all()).results;
  const templates = (await db.prepare(`SELECT * FROM session_templates ORDER BY location_id,weekday,time_msk`).all()).results;
  const sessions = (await db.prepare(
    `SELECT s.*, l.title AS loc_title FROM sessions s JOIN locations l ON l.id=s.location_id
      WHERE s.starts_at >= ?1 ORDER BY s.starts_at`).bind(nowI).all()).results;
  const bookings = (await db.prepare(
    `SELECT b.id, b.session_id, b.child_name, b.child_age, b.status, b.amount_kopecks, b.paid_with, b.created_at,
            c.name AS parent_name, c.phone
       FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE b.session_id IN (SELECT id FROM sessions WHERE starts_at >= ?1)
        AND b.status IN ('paid','attended','hold','no_show')
      ORDER BY b.created_at`).bind(nowI).all()).results;
  return { now: nowI, locations, instructors, templates, sessions, bookings };
}
const ADMIN_BOOKING_STATUSES = ['paid', 'attended', 'no_show', 'cancelled'];

// есть ли активные брони на будущих занятиях шаблона
async function templateHasBookings(db, tplId) {
  const r = await db.prepare(
    `SELECT count(*) n FROM bookings WHERE status IN ('paid','attended','hold')
       AND session_id IN (SELECT id FROM sessions WHERE template_id=? AND starts_at>=?)`
  ).bind(tplId, nowIso()).first();
  return (r && r.n) > 0;
}
// редактирование шаблона: удалить будущие НЕзабронированные занятия и пересоздать
async function regenerateTemplate(db, tplId) {
  await db.prepare(
    `DELETE FROM sessions WHERE template_id=? AND starts_at>=? AND status IN ('open','closed')
       AND id NOT IN (SELECT session_id FROM bookings WHERE status IN ('paid','attended','hold'))`
  ).bind(tplId, nowIso()).run();
  await syncSchedule(db);
}
async function sessionBookings(db, sid) {
  return (await db.prepare(
    `SELECT b.child_name, b.amount_kopecks, c.name AS parent_name, c.phone
       FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE b.session_id=? AND b.status IN ('paid','attended','hold')`
  ).bind(sid).all()).results;
}
async function notifyCancellation(env, info, bk) {
  const dt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  }).format(new Date(info.starts_at));
  const lines = bk.map((x) => '• ' + (x.child_name || '') + ' — ' + (x.parent_name || '') + ', ' + (x.phone || '')
    + (x.amount_kopecks > 0 ? (' (оплачено ' + x.amount_kopecks / 100 + ' ₽)') : ''));
  const text = ['⛔ Занятие отменено', '🏠 ' + info.loc, '🗓 ' + dt + ' (МСК) · группа ' + info.age_group,
    '', 'Записаны (' + bk.length + '):', lines.join('\n'),
    '', 'Предупредите клиентов об отмене и оформите возврат.'].join('\n');
  const tasks = [];
  if (env.TG_TOKEN && env.TG_CHAT_ID) tasks.push(sendTelegram(env, text));
  if (env.VK_TOKEN && env.VK_PEER) tasks.push(sendVK(env, text));
  await Promise.allSettled(tasks);
}

async function adminRouter(req, env, pathname) {
  if (!adminAuth(req, env)) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  if (pathname === '/api/admin/data' && req.method === 'GET')
    return json(await adminData(db));

  if (pathname === '/api/admin/upsert' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const id = await adminUpsert(db, b.table, b.row || {});
    if (b.table === 'session_templates') {
      if (b.row && b.row.id) await regenerateTemplate(db, id); // редактирование → пересоздать занятия
      else await syncSchedule(db);                             // новый шаблон → сгенерировать
    }
    return json({ ok: true, id });
  }

  if (pathname === '/api/admin/booking' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!b.id || !ADMIN_BOOKING_STATUSES.includes(b.status)) return json({ error: 'bad_request' }, 400);
    await db.prepare(`UPDATE bookings SET status=? WHERE id=?`).bind(b.status, b.id).run();
    return json({ ok: true });
  }

  // удаление шаблона или разового занятия (с защитой от удаления при бронях)
  if (pathname === '/api/admin/delete' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (b.table === 'session_templates') {
      if (await templateHasBookings(db, b.id)) return json({ error: 'has_bookings' }, 409);
      await db.prepare(`DELETE FROM sessions WHERE template_id=? AND starts_at>=?`).bind(b.id, nowIso()).run();
      await db.prepare(`UPDATE sessions SET template_id=NULL WHERE template_id=?`).bind(b.id).run(); // прошлые — отвязать
      await db.prepare(`DELETE FROM session_templates WHERE id=?`).bind(b.id).run();
      return json({ ok: true });
    }
    if (b.table === 'sessions') {
      const has = await db.prepare(`SELECT count(*) n FROM bookings WHERE session_id=? AND status IN ('paid','attended','hold')`).bind(b.id).first();
      if ((has && has.n) > 0) return json({ error: 'has_bookings' }, 409);
      await db.prepare(`DELETE FROM sessions WHERE id=?`).bind(b.id).run();
      return json({ ok: true });
    }
    return json({ error: 'bad_table' }, 400);
  }

  // отмена конкретного занятия (одна дата) + уведомление записавшимся
  if (pathname === '/api/admin/cancel-session' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const info = await db.prepare(
      `SELECT s.starts_at, s.age_group, l.title AS loc FROM sessions s JOIN locations l ON l.id=s.location_id WHERE s.id=?`
    ).bind(b.id).first();
    if (!info) return json({ error: 'not_found' }, 404);
    const bk = await sessionBookings(db, b.id);
    await db.prepare(`UPDATE sessions SET status='cancelled' WHERE id=?`).bind(b.id).run();
    if (bk.length) await notifyCancellation(env, info, bk);
    return json({ ok: true, notified: bk.length });
  }

  return json({ error: 'not_found' }, 404);
}

// ---------- роутер ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/api/health')
        return json({ ok: true, now: nowIso() });

      if (pathname === '/api/materialize' && req.method === 'POST')
        return json({ ok: true, materialized: await syncSchedule(env.DB) });

      if (pathname === '/api/schedule' && req.method === 'GET')
        return json(await getSchedule(env.DB));

      if (pathname === '/api/book' && req.method === 'POST')
        return book(env, await req.json().catch(() => null));

      if (pathname === '/api/payment/notify' && req.method === 'POST')
        return paymentNotify(env, await req.json().catch(() => null));

      if (pathname.startsWith('/api/admin/'))
        return adminRouter(req, env, pathname);

      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // ежедневная генерация занятий на горизонт
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncSchedule(env.DB));
  },
};
