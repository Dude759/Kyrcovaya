# Stage 3A — Reservation Core

26 октября 2026 года. **Stage 3A — GREEN / CLOSED.** PR №5 влит: main b26b010189a9cabcb3938a7af71a98a17220203a; backend 30, frontend 51, автоматические Render/Pages и публичный smoke 8/8. Ссылки на CI/deploy и итог приёмки сохранены в [PR Stage 3A №5](https://github.com/Dude759/Kyrcovaya/pull/5). Ниже сохранены исходные условия локального прогона от main 8d1a0d4; платежи и пользовательская подтверждённая бронь не входили в 3A.

## Реализация и границы

- [002_reservations.sql](../../backend/migrations/002_reservations.sql): btree_gist в public, connector_reservations, timestamptz, проверка конечных времён и положительного диапазона, ограничение held TTL, частичное GiST EXCLUDE для held/confirmed.
- [Сервис](../../backend/src/modules/reservations/service.ts): только внутренние createHold / createHoldInTransaction / releaseHold. Обязательная организация из доверенного серверного контекста; станция и физический порт проверяются в транзакции. У HTTP-клиента нет права вызвать их через POST.
- Порядок блокировок: станция FOR SHARE → подходящие физические порты FOR UPDATE по UUID → резервы. Для небольшого учебного каталога блокируется набор кандидатов одного типа: это безопасная сериализация, не заявление о высокой производительности. После ожидания время проверяется заново.
- Перед поиском порта истёкший held явно становится expired. Остальные held и confirmed блокируют. Индекс не содержит now(). Отдельный фоновой очиститель на этом этапе не запущен; очистка выполняется по требованию при выборе порта.
- TTL не более 15 минут и не позже start. Повтор release idempotent; confirmed нельзя освободить функцией отмены hold. Подтверждение и отмена оплаченной брони — будущие операции.
- SQLSTATE 23P01 отображается в безопасный конфликт 409; внутренние deadlock/serialization retry ограничены тремя попытками и содержат только SQL, без внешних списаний.
- GET availability доступен только driver; ISO-время со смещением, 30/45/60/90 минут, начало в будущем не далее четырёх суток. GET не меняет БД, игнорирует elapsed held в оценке, но не гарантирует будущего успеха удержания.
- Цена — учебная оценка по серверным тарифу/профилю, без чтения суммы от клиента. При отсутствии портов — null. Формула и поля — в [OpenAPI](../../backend/openapi/reservations.yaml).

Не добавлены payments, payment_events, webhook, bookings, charging_sessions, телеметрия. Поля payment_id/booking_id и их FK добавятся вместе с соответствующими таблицами; в этой миграции нет неработающих ссылок. HTTP frontend сохраняет отключённое создание брони; его UI не обозначает hold как оплаченную бронь.

## Проверки

Команды из backend: `npm run check`, `npm run build`, `npm test`. Из frontend: `npm run lint`, `npm test`, `npm run build`. PostgreSQL 17 в локальном Docker, Node.js 24, отдельная БД с суффиксом _test, случайные изолированные схемы. Тесты не используют публичную Neon. Старые миграции не изменялись.

| ID | Фактически проверяется |
| --- | --- |
| R00 | Миграция повторяема, btree_gist, timestamptz, частичный EXCLUDE |
| R01 | Свободный интервал, TTL и ограничение временем начала |
| R02 | Одинаковые диапазоны одного порта → 23P01 |
| R03 | Частичное пересечение, held против confirmed |
| R04 | Соседние [a,b), [b,c), эквивалентные смещения UTC/+03:00 |
| R05 | Два физических порта одной станции |
| R06 | Две разные станции |
| R07 | released, повтор release, запрет чужой организации и отмены confirmed |
| R08 | expired освобождает интервал |
| R09 | Просроченный held явно обновлён до выбора нового порта |
| R10 | Несуществующий/чужой/не той станции порт, архив, offline/service, FK |
| R11 | end <= start, infinity и held без expires_at запрещены в БД |
| R12 | Две реальные транзакции: pg_backend_pid различаются, pg_blocking_pids подтверждает ожидание второй, commit первой → 23P01 второй; в БД одна строка |
| R13 | Два параллельных вызова сервисного слоя на один порт: один hold, один 409 |
| R14 | Автовыбор физических портов в параллельных вызовах даёт разные UUID |
| R15 | Серверная доступность, цена, соседние интервалы, release, elapsed held; GET не пишет |
| R16 | Валидация, горизонт/таймзона, 401/403/404; POST bookings/payments=501, reservations=404 |
| R17 | Все порты заняты, offline/service станция, отсутствующий тип → 0 и цена null |

Исходник: [reservations.test.ts](../../backend/tests/reservations.test.ts). Локально PASS: 30 backend-тестов (12 прежних и 18 R00–R17), TypeScript check/build; 51 frontend-тест, lint/build. Миграция также применена к независимой локальной Docker-БД командой db:migrate. B01 дополнен ожидаемой новой таблицей. Результаты публикации, commit, PR/CI/deploy и публичного smoke добавляются в PR при закрытии этапа; сам локальный прогон не доказывает работу облачного стенда.

## Публичная приёмка

После зелёного CI и merge ожидаются автоматические Pages и Render с одинаковым main. Bootstrap применяет новую миграцию перед открытием порта. Read-only запросом проверяются миграция, extension и exclusion definition в Neon. Публичный smoke: `node backend/scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations`. Он использует вымышленные профили и проверяет availability/роли/валидацию и отсутствие публичного обхода оплаты. Конкурирующие записи резервов проверяются только на отдельной PostgreSQL; демонстрационный каталог ими не засоряется.

Источники: [PostgreSQL 17 btree_gist](https://www.postgresql.org/docs/17/btree-gist.html), [диапазоны и exclusion](https://www.postgresql.org/docs/17/rangetypes.html#RANGETYPES-CONSTRAINT), [блокировки](https://www.postgresql.org/docs/17/explicit-locking.html).
