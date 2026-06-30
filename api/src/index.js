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
  'access-control-allow-headers': 'content-type',
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
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return '+' + d;
}

async function upsertClient(db, { phone, name, consent_pd, consent_offer, source }) {
  const norm = normPhone(phone);
  const ex = await db.prepare(`SELECT id FROM clients WHERE phone=?`).bind(norm).first();
  if (ex) {
    await db.prepare(
      `UPDATE clients SET name=COALESCE(?,name), consent_pd=?, consent_offer=? WHERE id=?`
    ).bind(name || null, consent_pd ? 1 : 0, consent_offer ? 1 : 0, ex.id).run();
    return ex.id;
  }
  const ins = await db.prepare(
    `INSERT INTO clients (phone,name,consent_pd,consent_offer,source) VALUES (?,?,?,?,?)`
  ).bind(norm, name || null, consent_pd ? 1 : 0, consent_offer ? 1 : 0, source || 'web').run();
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
  if (!b.consent_pd || !b.consent_offer)
    return json({ error: 'consent_required' }, 400);

  const s = await db.prepare(`SELECT * FROM sessions WHERE id=?`).bind(b.session_id).first();
  if (!s || s.status !== 'open') return json({ error: 'session_unavailable' }, 404);
  const nowI = nowIso();
  if (s.starts_at < nowI) return json({ error: 'session_past' }, 409);

  const clientId = await upsertClient(db, {
    phone: b.phone, name: b.parent_name, consent_pd: b.consent_pd, consent_offer: b.consent_offer,
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
    // TODO (следующий шаг): уведомление в TG/ВК — только оплаченные брони.
  } else if (['REJECTED', 'REFUNDED', 'REVERSED', 'PARTIAL_REFUNDED'].includes(status)) {
    await db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).bind(pay.booking_id).run();
  }
  return new Response('OK');
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
        return json({ ok: true, materialized: await materialize(env.DB) });

      if (pathname === '/api/schedule' && req.method === 'GET')
        return json(await getSchedule(env.DB));

      if (pathname === '/api/book' && req.method === 'POST')
        return book(env, await req.json().catch(() => null));

      if (pathname === '/api/payment/notify' && req.method === 'POST')
        return paymentNotify(env, await req.json().catch(() => null));

      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // ежедневная генерация занятий на горизонт
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(materialize(env.DB));
  },
};
