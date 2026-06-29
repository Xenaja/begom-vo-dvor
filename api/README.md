# begom-api — бэкенд «Бегом во двор»

Cloudflare Worker + база D1. Обслуживает расписание, запись и (далее) оплату/уведомления.

- Worker: https://begom-api.xenonline77.workers.dev
- База D1: `begom` (биндинг `DB`), регион EEUR.

## Файлы

- `src/index.js` — код Worker: роутер, материализация занятий из шаблонов, расписание, запись.
- `schema.sql` — схема (14 таблиц, L1/L2/L3). Идемпотентна (`CREATE TABLE IF NOT EXISTS`).
- `seed.sql` — реальное расписание июля 2026 (локации, пробные занятия, шаблоны регулярки).
- `wrangler.toml` — конфиг: биндинг D1, крон материализации, переменные.

## Требования

- Node.js 18+ и доступ к Cloudflare (`npx wrangler login` или OAuth-токен).
- Все команды запускать из папки `api/`.

## Частые команды

```bash
# залить/обновить схему
npx wrangler d1 execute begom --remote --file=schema.sql

# залить сид (первичные данные)
npx wrangler d1 execute begom --remote --file=seed.sql

# произвольный запрос
npx wrangler d1 execute begom --remote --command "SELECT count(*) FROM sessions;"

# локальная проверка схемы (без облака)
npx wrangler d1 execute begom --local --file=schema.sql

# деплой Worker
npx wrangler deploy

# логи в реальном времени
npx wrangler tail
```

## Эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| GET  | `/api/health` | `{ok, now}` |
| GET  | `/api/schedule` | `{now, locations[], sessions[]}` — занятия с полем `free` |
| POST | `/api/materialize` | генерирует `sessions` из активных шаблонов на 28 дней; возвращает число вставленных |
| POST | `/api/book` | запись; тело `{session_id, parent_name, phone, child_name, child_age, consent_pd, consent_offer}` |

Коды `/api/book`: `200 {ok}` — записан; `400 consent_required|missing_fields`;
`404 session_unavailable`; `409 no_seats|session_past`; `501 payment_not_configured` (регулярные — до подключения Т-Банка).

## Расписание: шаблоны → занятия

Регулярные тренировки задаются в `session_templates` (двор + день недели + время МСК + группа).
Конкретные `sessions` (единица брони) **материализуются** из шаблонов:
- ежедневно кроном `0 3 * * *` (06:00 МСК) на горизонт `HORIZON_DAYS = 28`;
- вручную через `POST /api/materialize`.
Идемпотентность — частичный уникальный индекс `(template_id, starts_at)`.
Пробные занятия — разовые `sessions` без шаблона (`kind='trial'`, цена 0).

## Дальше (TODO)

- Оплата Т-Банка: `POST /api/book` для регулярных → создать `hold` + Init → `PaymentURL`;
  вебхук `POST /api/payment/notify` → при `CONFIRMED` пометить `paid` и уведомить.
  Секреты: `TBANK_TERMINAL`, `TBANK_PASSWORD` (через `wrangler secret put`).
- Уведомления (только оплаченные): TG `sendMessage` + ВК `messages.send`.
  Секреты: `TG_TOKEN`, `TG_CHAT_ID`, `VK_TOKEN`, `VK_PEER`.
- Админка: расписание, инструкторы, записи (роль `admin`/`instructor`).
