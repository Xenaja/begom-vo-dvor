-- ============================================================
--  «Бегом во двор» — схема БД (Cloudflare D1 / SQLite)
--  Деньги — в копейках (INTEGER), без float.
--  Время — ISO8601 в UTC (TEXT), на фронте показываем в МСК.
--  Группировка по фазам: SPINE/L1 → L2 → L3.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============ SPINE / L1 ============

-- Клиенты — «хребет» системы: лиды + записавшиеся + привязка к
-- мессенджерам (для бот-кабинета) + кошелёк (для переноса оплаты).
CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY,
  phone           TEXT UNIQUE,            -- нормализованный +7XXXXXXXXXX (стабильный ключ)
  name            TEXT,
  tg_id           TEXT,                   -- chat_id Telegram (бот-кабинет L3)
  vk_id           TEXT,                   -- id ВК (бот-кабинет L3)
  balance_kopecks INTEGER NOT NULL DEFAULT 0,  -- кошелёк (перенос оплаты, L2)
  source          TEXT,                   -- web | leadmag | admin | bot | referral
  consent_pd      INTEGER NOT NULL DEFAULT 0,  -- согласие на обработку ПД (0/1) — обязателен
  consent_offer   INTEGER NOT NULL DEFAULT 0,  -- согласие с офертой/польз.соглашением (0/1) — обязателен
  consent_marketing INTEGER NOT NULL DEFAULT 0, -- согласие на рекламные/информационные сообщения (0/1) — опционально
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

-- Пользователи админки: админ или тренер (роли — для L2).
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  login      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,               -- хэш пароля (PBKDF2/scrypt)
  role       TEXT NOT NULL DEFAULT 'admin',  -- admin | instructor
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Локации (дворы / площадки).
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,              -- «ЖК Граффити»
  address     TEXT,
  district    TEXT,                       -- район / город
  yard_type   TEXT,                       -- 'открытый' | 'закрытый' двор
  access_note TEXT,                       -- «для жителей ЖК» и т.п.
  surface     TEXT,                       -- покрытие: «коробка, иск.трава футб.поля», «каучук»
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Инструкторы (карточки на лендинге; назначение на занятия и ЗП — L2).
CREATE TABLE IF NOT EXISTS instructors (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  experience       TEXT,                  -- «опыт одной строкой» для карточки
  photo_url        TEXT,
  pay_rate_kopecks INTEGER NOT NULL DEFAULT 0,  -- ставка за проведённое занятие (L2)
  user_id          INTEGER REFERENCES users(id),  -- логин тренера (L2)
  active           INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0
);

-- Шаблоны регулярного расписания (повторяющиеся тренировки «с 13.07»).
-- Админ задаёт правило (двор + день недели + время + группа), из него
-- материализуются конкретные занятия (sessions) на N недель вперёд.
CREATE TABLE IF NOT EXISTS session_templates (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  instructor_id INTEGER REFERENCES instructors(id),
  weekday       INTEGER NOT NULL,         -- ISO: 1=пн … 7=вс
  time_msk      TEXT NOT NULL,            -- 'HH:MM' по МСК
  duration_min  INTEGER NOT NULL DEFAULT 45,
  age_group     TEXT NOT NULL,            -- '4-6' | '7-9'
  capacity      INTEGER NOT NULL DEFAULT 12,
  price_kopecks INTEGER NOT NULL DEFAULT 35000,
  valid_from    TEXT,                     -- дата начала действия (напр. 2026-07-13)
  valid_until   TEXT,                     -- дата окончания (NULL = бессрочно)
  active        INTEGER NOT NULL DEFAULT 1
);

-- Занятия — конкретный слот: двор + дата/время + возрастная группа.
-- Единица брони. template_id = из какого шаблона (NULL = разовое, напр. пробное).
-- Остаток мест НЕ храним полем, а считаем = capacity − активные брони
-- (см. логику резерва в коде), чтобы не было рассинхрона.
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  instructor_id INTEGER REFERENCES instructors(id),  -- назначает админ (L2)
  template_id   INTEGER REFERENCES session_templates(id),  -- NULL = разовое (пробное)
  kind          TEXT NOT NULL DEFAULT 'regular',     -- regular | trial
  starts_at     TEXT NOT NULL,            -- ISO8601 UTC
  duration_min  INTEGER NOT NULL DEFAULT 45,
  age_group     TEXT NOT NULL,            -- '4-6' | '7-9'
  capacity      INTEGER NOT NULL DEFAULT 12,
  price_kopecks INTEGER NOT NULL DEFAULT 35000,  -- 350 ₽ (пробное может быть 0/иным)
  status        TEXT NOT NULL DEFAULT 'open',     -- open | closed | cancelled
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_starts ON sessions(starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_loc    ON sessions(location_id);
-- идемпотентность материализации: один слот шаблона на дату-время
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_tpl_slot
  ON sessions(template_id, starts_at) WHERE template_id IS NOT NULL;

-- Записи — бронь места ребёнком на занятие.
-- Занятость места = бронь в статусе 'hold' (не истёкшая) | 'paid' | 'attended'.
CREATE TABLE IF NOT EXISTS bookings (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id),
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  child_name         TEXT,
  child_age          INTEGER,
  status             TEXT NOT NULL DEFAULT 'hold',
      -- hold (резерв до оплаты) | paid | cancelled | attended | no_show | expired
  amount_kopecks     INTEGER NOT NULL,
  hold_expires_at    TEXT,                -- докуда держим место без оплаты (UTC)
  paid_with          TEXT,                -- tbank | balance | manual
  source             TEXT NOT NULL DEFAULT 'web',  -- web | admin | bot
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  paid_at            TEXT,
  -- посещаемость (L2): отмечает инструктор
  attended_marked_by INTEGER REFERENCES users(id),
  attended_marked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_client  ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);

-- Платежи — эквайринг Т-Банка. Отдельная таблица (а не поля в bookings),
-- чтобы поддержать возвраты/переносы и хранить сырой webhook для отладки.
CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY,
  booking_id          INTEGER NOT NULL REFERENCES bookings(id),
  provider            TEXT NOT NULL DEFAULT 'tbank',
  provider_payment_id TEXT,               -- PaymentId от Т-Банка
  order_id            TEXT UNIQUE,        -- наш OrderId (идемпотентность)
  amount_kopecks      INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new',  -- new | confirmed | rejected | refunded
  payment_url         TEXT,               -- PaymentURL для редиректа
  raw                 TEXT,               -- последний webhook (JSON), отладка
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  confirmed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- ============ L2 ============

-- Теги/сегменты клиентов (M2M) — для сегментации базы и рассылок.
CREATE TABLE IF NOT EXISTS client_tags (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (client_id, tag)
);

-- Движения по балансу клиента (кошелёк): перенос оплаты, возвраты,
-- списание за занятие/абонемент, ручная корректировка. Баланс clients
-- = сумма всех движений (ledger — источник истины).
CREATE TABLE IF NOT EXISTS balance_transactions (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  delta_kopecks  INTEGER NOT NULL,        -- + начисление, − списание
  reason         TEXT NOT NULL,           -- transfer | refund | booking | subscription | manual
  ref_booking_id INTEGER REFERENCES bookings(id),
  comment        TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============ L3 ============

-- Абонементы (пакет занятий со списанием за визит).
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  title          TEXT,
  sessions_total INTEGER NOT NULL,
  sessions_left  INTEGER NOT NULL,
  valid_until    TEXT,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | used | expired
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Реферальная программа.
CREATE TABLE IF NOT EXISTS referrals (
  id                  INTEGER PRIMARY KEY,
  referrer_client_id  INTEGER NOT NULL REFERENCES clients(id),
  referred_client_id  INTEGER REFERENCES clients(id),
  code                TEXT UNIQUE NOT NULL,
  reward_status       TEXT NOT NULL DEFAULT 'pending',  -- pending | granted
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Рассылки по сегментам (TG/VK/email) — планировщик через Cron Triggers.
CREATE TABLE IF NOT EXISTS broadcasts (
  id           INTEGER PRIMARY KEY,
  channel      TEXT NOT NULL,             -- tg | vk | email
  segment      TEXT,                      -- тег сегмента или 'all'
  body         TEXT NOT NULL,
  scheduled_at TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sent
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at      TEXT
);

-- Настройки/тумблеры (ключи интеграций -> в Secrets, а здесь тексты:
-- trialBanner, ctaLabel, showPlaceholders, hold_minutes и т.п.).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
