# Stage 3B — Test Payments

26 октября 2026 года. Исходный main b26b010; Stage 2A/2B/3A — GREEN / CLOSED. Этот протокол фиксирует локальную реализацию; окончательные CI/merge/Render/Pages и публичный smoke записываются в связанном PR. До их успешной проверки Stage 3B — GREEN (local), не CLOSED.

## Реализовано

- [003_payments.sql](../../backend/migrations/003_payments.sql): payments, payment_attempts, payment_events; UNIQUE user/key, payment/attempt_no, payment/retry_key, provider/provider_payment_id, provider/provider_event_id; один pending attempt на заказ. Reservation payment_id уникален, составной FK защищает совпадение порта и интервала. SQL-триггер запрещает менять снимок заказа.
- [Платёжный сервис](../../backend/src/modules/payments/service.ts): driver-only API, серверный quote, атомарное создание заказа/hold/попытки, retry на том же порту и исходном TTL, cancel/fail, expiry и разграничение владельца. Новый заказ невидим другим транзакциям до общего commit; создающие запросы одного пользователя сериализованы advisory lock, а существующий заказ — FOR UPDATE перед портом/резервом. Это не заявление о масштабируемости.
- [Тестовый адаптер](../../backend/src/modules/payments/provider.ts) и HTTPS страница с тремя симулируемыми исходами. Номер карты/CVV не запрашиваются. Подписанная capability ссылки производна от server secret/UUID, не хранится в confirmation_url в БД; ссылка возвращается только владельцу. GET страницы не означает оплату.
- [Подписанный inbox](../../backend/src/modules/payments/routes.ts): HMAC-SHA256 timestamp + '.' + исходные JSON-байты, ±300 секунд, timingSafeEqual, лимит 4 КБ. JSON разбирается после проверки; неизвестные поля запрещены. В БД только разрешённые поля и hash нормализованного события, не сырой payload.
- Адаптер in-process: действие страницы формирует подписанное событие и доставляет его через тот же проверяющий inbox, что HTTP webhook. Внешнего банковского запроса внутри транзакции нет. Реальный подписанный HTTP endpoint проверяется интеграционными тестами; публичный smoke использует HTTPS форму адаптера, не получает secret.
- Provider success: attempt=succeeded, payment=pending, awaitingFinalization=true, bookingId=null, hold всё ещё held до исходного TTL. SQL CHECK запрещает payment=succeeded в 3B. Поздний/истёкший успех сохраняется для будущей сверки; не создаёт бронь, не продлевает hold, не выдаёт возврат за выполненный.
- Frontend передаёт Idempotency-Key заголовком для HTTP checkout/retry; отдельный mock сохранён. Checkout показывает ожидание финализации/сверки и не предлагает оплатить снова после success провайдера. Основной пользовательский переход создания брони отключён до 3C; workspace остаётся Foundation-агрегатом с пустыми бронями/платежами/сессиями.

Референс API: [OpenAPI](../../backend/openapi/payments.yaml). Публичных POST hold/booking и charging sessions нет. Отмена после provider success возвращает 409; это не имитирует возврат. После истечения остаётся failure=expired и при полученном success — requiresReconciliation=true.

## Фактические локальные проверки

Node.js 24, PostgreSQL 17 Docker; отдельная _test БД, случайные схемы. `npm run check`, `npm run build`, `npm test` из backend: **50 PASS**, включая прежние 30 Foundation/Reservation и P00–P19. Frontend lint/test/build: **54 PASS**, включая HTTP-заголовки и две UI-проверки границы provider success/booking.

| ID | Проверка |
| --- | --- |
| P00 | Повтор миграции, таблицы/связи, FK на несуществующие объекты, CORS Idempotency-Key |
| P01 | pending + один физический hold + первая попытка, TTL и составной FK |
| P02 | Серверная цена, неизменяемость снимка, отказ клиентским суммам/карточным полям |
| P03 | Повтор user/key, нормализация timezone, одинаковые ключи разных пользователей |
| P04 | Другой payload прежнего ключа, отсутствующий/некорректный ключ |
| P05 | Два параллельных HTTP POST с одним ключом → один payment/hold/attempt |
| P06 | Два водителя и разные ключи на последний порт → один 201, второй 409, нет orphan |
| P07 | Retry: новая попытка, тот же order/port/reservation/amount/expiresAt; повтор ключа не создаёт попытку |
| P08 | Идемпотентная отмена и освобождение hold; запрет retry отменённого |
| P09 | fail освобождает hold; старое событие не освобождает новый retry |
| P10 | Валидный success только на attempt; payment.pending, booking=null, SQL запрет business succeeded |
| P11 | Неверная/отсутствующая/старая/подменённая подпись, чужая сумма, запрещённые поля; inbox не загрязняется |
| P12 | Повтор event при ином форматировании JSON; processed_at неизменён, другой payload того же ID конфликтует |
| P13 | Чужой driver 404, operator 403, guest 401; чужая capability не работает |
| P14 | Реальный короткий TTL, expiry сохраняется после отказа retry; поздний success не забирает порт у нового заказа |
| P15 | Реальный OS process restart между create и событием; сохраняются ключ, hold и dedup |
| P16 | HTTPS confirmation URL, HTML без карточных полей, проверка Origin формы, повтор-safe signed delivery |
| P17 | Успех провайдера не продлевает TTL; после expiry требуется сверка, а не ложная бронь |
| P18 | Два параллельных одинаковых provider events → одна строка и один эффект |
| P19 | Cancel одновременно с success → согласованное состояние; нет payment.succeeded без booking |

Источник: [payments.test.ts](../../backend/tests/payments.test.ts). Старый B01 дополнен новыми таблицами; проверки пустого POST payments теперь ожидают 400 вместо прежнего 501, поскольку endpoint реализован. POST bookings/sessions по-прежнему 501. Положительные старые сценарии не удалялись. Полный прогон миграции/связей выполняется только в своей временной тестовой схеме, не на рабочей Neon.

## Публикационная приёмка

Render — существующий Free service, source of truth конфигурации в Render. Добавляются только PAYMENT_PUBLIC_ORIGIN и PAYMENT_WEBHOOK_SECRET через merge env, без замены других ключей. Secret не передаётся frontend и не фиксируется в Git. Для реального публичного HTTPS confirmationUrl origin должен указывать на этот API. Локальный HTTP backend без TLS-прокси не изображает HTTPS провайдера: настройка optional, платёжный endpoint с корректными данными без настройки вернёт 503.

После зелёного CI: PR → main → автоматические Render/Pages с тем же commit → read-only проверка 003/FK/состояний в Neon → `node backend/scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations --payments`. Smoke создаёт только вымышленные записи, повторяет create и provider result, проверяет retry/cancel, затем ждёт короткий TTL тестовой заявки, чтобы не оставить активный hold. Приватные токены и capability URL не печатаются. Публичная гонка последнего порта не устраивается: она доказана на отдельной PostgreSQL.

Сроки хранятся в timestamptz, lazy expiry используется перед чтением/изменением заказа и повторным выбором порта; отдельный scheduler не заявлен. Это функциональная приёмка учебного адаптера, не банковский биллинг, фискализация, нагрузочный тест или автоматический refund. Stage 3C впервые свяжет payment.succeeded + reservation.confirmed + booking в одной транзакции.

Источники: [Node.js crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), [Express raw](https://expressjs.com/en/api.html#express.raw), [PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html), [Render environment](https://render.com/docs/configure-environment-variables).
