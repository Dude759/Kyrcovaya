# Энерготранспорт — Backend v0.4

Express 5 + TypeScript, Node.js 24, PostgreSQL 17 и `pg`, без ORM. Реализованы аккаунты, профиль, каталог, Reservation Core, Test Payments и атомарная финализация подтверждённой брони. Зарядка, управление оборудованием и ML относятся к следующим этапам.

Публичная версия: [приложение](https://dude759.github.io/Kyrcovaya/), [health API](https://energotransport-api-dude759.onrender.com/health). API — Render Free, БД — Neon Free. [Конфигурация и правила публикации](../docs/public-demo.md), [протокол](../docs/testing/public-results.md). Ниже описан независимый локальный запуск с Docker; его .env не заменяется облачными секретами.

## Локальный запуск

Все команды этого раздела выполняются из `backend/`. Нужны Node.js 24 и работающий Docker Desktop либо собственная PostgreSQL 17.

```powershell
npm ci
Copy-Item .env.example .env
```

Заполните `.env`: замените `CHANGE_ME` одинаковым паролем в `POSTGRES_PASSWORD`, `DATABASE_URL` и `TEST_DATABASE_URL`; задайте `SEED_OPERATOR_PASSWORD` и `SEED_DRIVER_PASSWORD` длиной 8–128 символов. При спецсимволах пароль в URL кодируется. `.env` игнорируется Git. Для локальной учебной демонстрации можно задать seed-пароли `Demo12345`; код сервера не назначает их автоматически.

```powershell
docker compose up -d
npm run db:migrate
npm run db:seed
npm run build
npm start
```

API: `http://127.0.0.1:3001`. Разработка с перезапуском: `npm run dev`. Проверка процесса: `GET /health`; проверка соединения с БД: `GET /ready`. При недоступной БД readiness возвращает 503. Миграции запускаются отдельно, при старте сервера схема автоматически не изменяется.

При собственной PostgreSQL задайте URL существующей БД и пропустите Docker-команды. Для внешней БД TLS настраивается средствами строки подключения/доверенного CA; проверку сертификата код не отключает. Публичное размещение описано отдельно в docs/public-demo.md.

## Подключение интерфейса

В другом терминале из `frontend/`:

```powershell
npm ci
npm run dev:server
```

Откройте [localhost:5173](http://localhost:5173). Команда явно включает HTTP-режим независимо от `VITE_API_MODE` в общем `.env`; Vite проксирует `/api` на `127.0.0.1:3001`. `npm run dev` сохраняет прежний выбор режима из окружения, по умолчанию mock. Публичный GitHub Pages использует свой Render API и не обращается к локальному серверу.

Яндекс Карты используют существующий ключ `VITE_YANDEX_MAPS_API_KEY` во frontend. Ограничения ключа должны разрешать `localhost`; во время проверки настоящая карта работала на `localhost`, а на `127.0.0.1` показывалась подписанная резервная схема. В любом случае список станций HTTP-режима берётся из PostgreSQL. Без телеметрии нагрузка неизвестна, а не равна нулю. Состояние порта пока отражает учебную конфигурацию, не показание оборудования и не свободный будущий интервал.

## Миграции и seed

`migrations/001_foundation.sql` создаёт ровно семь предметных таблиц: `organizations`, `users`, `driver_profiles`, `user_preferences`, `auth_sessions`, `stations`, `connectors`. Восьмая таблица `schema_migrations` служебная: имя, SHA-256 файла и время применения. Миграции выполняются под транзакционной advisory-блокировкой; изменение уже применённого файла обнаруживается. Обратное разрушительное применение не автоматизировано — изменения схемы оформляются новой миграцией.

Seed запускается отдельной командой и сохраняет существующие записи: повтор не сбрасывает пароли, изменения профиля/станции или настройки. Он создаёт одну организацию, оператора, двух водителей, восемь учебных станций Москвы и 44 физических порта трёх типов. Адреса/координаты предназначены для демонстрации; это не заявление о работающих коммерческих ЭЗС.

| Роль | Email | Пароль |
| --- | --- | --- |
| Оператор | operator@energotransport.test | `SEED_OPERATOR_PASSWORD` |
| Водитель | driver@energotransport.test | `SEED_DRIVER_PASSWORD` |
| Водитель | driver2@energotransport.test | `SEED_DRIVER_PASSWORD` |

Новые операторы создаются служебно: заполните `OPERATOR_EMAIL`, `OPERATOR_NAME`, `OPERATOR_PASSWORD`, `OPERATOR_ORGANIZATION_ID` в локальном окружении и выполните `npm run operator:create`. Организация должна существовать; пароль не передаётся аргументом командной строки, не выводится и не заменяет пароль существующего пользователя. Публичная регистрация оператора запрещена.

## API этого инкремента

Полный транспортный контракт и будущие дополнения — в [API](../docs/frontend-api-contract.md).

| Метод и путь | Поведение |
| --- | --- |
| GET `/health`, `/ready` | Живость и готовность БД; доступны и с префиксом `/api` |
| POST `/api/auth/register` | Profile + password; только driver, 201 с `{user,token}` |
| POST `/api/auth/login` | email/password/role; роль сверяется с БД |
| GET `/api/auth/me` | Текущий пользователь; у operator нет полей автомобиля |
| POST `/api/auth/logout` | Отзыв текущей сессии, 204 |
| PATCH `/api/profile` | Полный профиль driver либо name/email/phone для operator |
| PATCH `/api/preferences` | Частичное изменение разрешённых boolean-полей |
| GET `/api/stations` | `{items,nextCursor}`; публичный каталог; валидный операторский токен ограничивает выборку его организацией |
| GET `/api/stations/:id` | Совместимая карточка Station; чужой объект для оператора — 404 |
| GET `/api/stations/:id/connectors` | Отдельные физические порты с ID, типом, мощностью и состоянием |
| GET `/api/stations/:id/availability` | Только driver; start с таймзоной, duration 30/45/60/90 минут, connector; оценка свободных портов и цены без удержания |
| POST `/api/payments` | Driver; `{input:BookingInput}` и заголовок Idempotency-Key; pending order + hold + attempt |
| GET `/api/payments/:id` | Только свой заказ, с обработкой expiry |
| POST `/api/payments/:id/retry` | Пустое тело, Idempotency-Key нового retry; новая попытка того же заказа/порта/TTL |
| POST `/api/payments/:id/cancel` | Отмена до provider success, освобождение hold, идемпотентно |
| POST `/api/integrations/payments/test/events` | HMAC подписанного raw JSON; Bearer пользователя подпись не заменяет |
| GET `/api/workspace` | Станции, свои настройки и организация; свои bookings/payments для driver (stage=bookings); сессии/события пустые, forecast=null; operator остаётся stage=foundation |

Фильтры каталога: `q`, `connector`, `minPowerKw`, `availableOnly=true|false`, `limit` 1–200, `cursor` из предыдущего ответа. Порядок стабильный по ID. Workspace ограничен учебным стендом до 200 станций и не обрезает его молча. Для большего каталога требуется постраничная загрузка рабочей области; публичная главная уже читает все страницы каталога.

Неподдерживаемые серверные операции возвращают 501 с понятным сообщением. Водительские запросы к операторским функциям возвращают 403. Восстановление и смена пароля пока не реализованы; публичный recovery возвращает 501. Маршрутов имитации `/api/demo` на сервере нет. В HTTP-режиме нет автоматического переключения на localStorage/mock при ошибках API.

Пароли хешируются `scrypt` с N=131072, r=8, p=1 и случайной солью; Bearer — 32 случайных байта, в БД SHA-256. Срок по умолчанию семь суток; отключённый пользователь, истечение и logout прекращают доступ. Повторный запуск процесса не отзывает действующие токены. Вход/регистрация ограничены 30 попытками за 15 минут на IP в памяти процесса. CORS допускает только перечисленные origins; секреты, SQL-значения и stack trace не возвращаются клиенту.

## Проверки на настоящей PostgreSQL

Создайте отдельную БД один раз:

```powershell
docker compose exec -T postgres createdb -U energotransport energotransport_test
npm run check
npm run build
npm test
```

Если БД уже существует, повтор `createdb` не нужен. `TEST_DATABASE_URL` обязателен и должен указывать на имя, заканчивающееся `_test`; fallback на рабочую БД отсутствует. Каждый прогон создаёт случайную схему `test_<hex>` и удаляет только её после завершения. В ней миграции, seed и API выполняются как в приложении. Публичная схема/данные рабочей БД не очищаются.

Тесты проверяют повтор seed, ограничения БД, хеширование, запрет operator-регистрации, роли, отзыв/истечение, изоляцию двух организаций, профиль/настройки через два реальных запуска процесса, физические порты, общий каталог, честный workspace, 501, CORS, readiness и публичную конфигурацию. [Локальный протокол Foundation](../docs/testing/backend-results.md), [облачные проверки и публичный smoke](../docs/testing/public-results.md). В GitHub Actions используется отдельная PostgreSQL 17; публичная рабочая БД тестами миграций не очищается.

Основные источники реализации: [Express 5](https://expressjs.com/en/guide/migrating-5/), [параметризованные запросы pg](https://node-postgres.com/features/queries), [Node.js 24 crypto/scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html), [ограничения PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-constraints.html).

## Проверка публичного выпуска

API размещён на Render Free, БД — Neon Free. После merge проверьте не только health/ready, но и commit живого deploy в Render: он должен совпадать с выпущенным main. Для автопубликации нужна связь сервиса с GitHub и установленное GitHub App Render с доступом к Kyrcovaya, а не только публичный URL репозитория или вход через GitHub. Инструкция и ограничения — [публичный стенд](../docs/public-demo.md); результаты и ссылка на закрывающий PR — [публичный протокол](../docs/testing/public-results.md).

## Reservation Core — Stage 3A

Миграция 002 устанавливает btree_gist (нужна привилегия CREATE в БД), добавляет connector_reservations и GiST EXCLUDE для пересечений [start,end) одного физического порта. Старый файл 001 не меняется. В тестах extension находится в public, вне временной схемы; удаление временной схемы не удаляет extension.

createHold / createHoldInTransaction / releaseHold — внутренние функции, не HTTP API. Организация берётся из доверенного серверного контекста; createHoldInTransaction вызывается только внутри открытой транзакции. Порт выбирается по UUID либо автоматически среди подходящих; offline/service и архив исключаются. Истёкший held явно переводится в expired перед выбором; TTL ограничен 15 минутами и start. Подтверждение оплаченной брони появится позднее.

GET availability доступен водителю, не создаёт резерв и не гарантирует свободный порт после ответа. Начало — в будущем не далее четырёх суток по часам PostgreSQL; время обязательно содержит Z или смещение. Передавайте query через URLSearchParams, чтобы +03:00 не превратилось в пробел. При отсутствии свободных портов available=0 и estimatedAmount=null. [OpenAPI](openapi/reservations.yaml), [протокол R-тестов](../docs/testing/reservation-results.md).

Публичная проверка после deploy: `node scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations`. Интеграционные тесты R00–R17 включены в обычный `npm test`; R12 проверяет ожидание двух PostgreSQL-транзакций, а не два последовательных запроса. Публичный frontend сохраняет отключённое бронирование до платёжного этапа.

## Test Payments — Stage 3B

Миграция 003 добавляет payments/attempts/events и payment_id резерва. Снимок заказа защищён от изменений SQL-триггером, в том числе при retry; новый attempt повторно удерживает тот же physical port с исходным expiresAt. Успех провайдера оставляет payment=pending, awaitingFinalization=true, bookingId=null; CHECK запрещает business succeeded до Stage 3C. Поздний успех отмечается для сверки, а не изображает бронь или refund.

Тестовый провайдер настраивается двумя серверными переменными: PAYMENT_PUBLIC_ORIGIN (HTTPS origin этого API) и PAYMENT_WEBHOOK_SECRET (случайный секрет длиной ≥32). Без обоих полей корректные платёжные операции дают 503; частичная настройка не запускает сервер. В Render значения хранятся в окружении сервиса; в локальный .env при необходимости добавляются свои. HTTP loopback не изображает HTTPS: для локальной страницы нужен HTTPS reverse proxy, либо проверяйте публичный учебный стенд. Секрет не должен иметь VITE-префикс, не выводится и не передаётся клиенту.

Confirmation URL открывает собственную HTTPS-страницу тестового адаптера с явной надписью «деньги не списываются». Там нет карточных полей. Ссылка содержит scoped capability; токен не хранится в БД/логах, не публикуйте URL. POST формы до TTL генерирует подписанное событие через общий inbox; GET не является оплатой. Webhook принимает raw JSON до общего JSON parser: HMAC-SHA256 timestamp+'.'+body, ±300 секунд, hex подпись в X-Test-Payment-Signature и секунды в X-Test-Payment-Timestamp. Внешних банковских запросов внутри SQL-транзакции нет.

[OpenAPI payments](openapi/payments.yaml), [P00–P19 и итог выпуска](../docs/testing/payment-results.md). Публичный smoke: `node scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations --payments`; он ждёт короткий TTL успешной тестовой попытки, чтобы не оставить активный hold. Истечение обрабатывается по требованию; отдельный scheduler, банковский биллинг и возвраты ещё не реализованы.

## Atomic Booking Finalization — Stage 3C

004 добавляет bookings, payment_compensations и долговечные test_refund_receipts. Success проверенного webhook теперь в одной транзакции создаёт одну confirmed booking, подтверждает тот же reservation и переводит payment в succeeded. UNIQUE/FK/deferred constraint triggers запрещают разрыв связей; неизменяемость заказа сохранена. Поля bookingId, finalizationReason и refunds описаны в [OpenAPI](openapi/payments.yaml).

Recovery запускается при старте API и раз в 15 секунд (до 20 записей); восстанавливает awaiting_booking/late_success из 3B. Просроченные старые hold не оживают: создаётся компенсация. Тестовый возврат сначала pending/submitted; succeeded появляется только после отдельной сохранённой квитанции адаптера. Ошибка/рестарт не теряют очередь и не меняют provider refund ID. Во время сна Free процесс не выполняется; восстановление продолжится после пробуждения. Секреты/настройки Render прежние.

Driver workspace содержит свои последние 100 bookings/payments; основной переход бронирования открыт. В 0.5 HTTP предлагает зарядку; отмена confirmed booking пока закрыта. Весь раздел Test Payments выше сохраняет историческую границу 3B; текущая версия использует финализацию 3C. [Протокол F00–F21](../docs/testing/booking-finalization-results.md). Публичный smoke --reservations --payments теперь проверяет атомарную бронь, её сохранность после исходного TTL и подтверждённый тестовый возврат позднего успеха.

## Server Charging Sessions — Stage 3D (v0.5)

005 добавляет серверную зарядку. [Правила и локальный протокол C00–C31](../docs/testing/charging-results.md), [OpenAPI](openapi/sessions.yaml).

| Метод | Поведение |
| --- | --- |
| POST `/api/sessions` | Driver, `{bookingId}` + Idempotency-Key; starting/202 до ack |
| GET `/api/sessions/:id` | Driver только свои, operator только организации; источник simulator |
| POST `/api/sessions/:id/stop` | Driver-владелец, `{}` + ключ; stopping/202 до финального измерения |
| GET `/api/workspace` | `charging=true`; последние 100 своих/организационных сессий; прежние stage сохраняются |

Запуск по часам PostgreSQL разрешён в [start, min(start+15 минут, end)); граница повторно проверяется устройством. Мощность min(22 кВт, порт, свободный лимит станции), не энергосистема. Команды/квитанции переживают рестарт. Имитатор обновляет измерения примерно каждые 10 секунд; цикл восстановления в API раз в секунду. После рестарта или разрыва >15 секунд gap не заполняется энергией; >60 секунд UI скрывает неизвестную мощность. SOC=null.

Счёт только после подтверждённого stop/final reading: ceil(Wh × тариф_коп / 1000). Остаток предоплаты имеет отдельные session_refunds/квитанции с pending/submitted/succeeded. 3C-компенсации сохранены отдельно. Общий финансовый бюджет защищён БД. Реальных денег и станций нет. Новых секретов или сервисов не требуется.

Полная публичная проверка: `node scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations --payments --charging`. Она выполняет реальные десятисекундные измерения имитатора и сохраняет учебную историю; гонки/сбои запускаются только в `_test` БД. Локально 104 backend и 68 frontend проверок PASS; статус публичной приёмки — в PR Stage 3D. Ранние разделы 3B/3C выше описывают исторические границы, текущий контракт — 0.5.

## Booking Cancellation & No-show — Stage 3E (0.6)

POST `/api/bookings/:id/cancel`, driver-владелец, строго `{}`. Идемпотентность по ID брони. До любой session — полный тестовый возврат без штрафа; после окна `[start, min(start+15 минут, end))` фиксируется no_show. Любая существовавшая session, включая failed, запрещает новый booking refund: расчёт принадлежит 3D. Used нельзя отменить. Оплата остаётся succeeded, а бронь становится cancelled/expired и резерв released/expired атомарно с намерением возврата.

006 сохраняет 001–005, добавляет booking_closures/booking_refunds/test_booking_refund_receipts и общий финансовый guard. Recovery при boot/примерно раз в 15 секунд, также driver workspace до snapshot; сон Free откладывает выполнение. Availability не объявляет виртуальное освобождение до SQL-перехода. UI polling броней раз в 5 секунд; pending/submitted не равны подтверждению возврата.

[OpenAPI](openapi/bookings.yaml), [протокол L00–L25](../docs/testing/booking-lifecycle-results.md). Локально 130 backend / 74 frontend PASS. Публичный smoke: прежние флаги плюс `--lifecycle` (17 групп). Настоящая неявка отдельно проверяется в браузере с ожиданием полного окна. Финальный статус выпуска — в PR Stage 3E.

## Stage 4A — управление станциями оператора

Миграция 007, аудит network_events и ключи operator_requests; API управления собственной организацией, физические порты, безопасные лимиты/режим/архив, HTTP формы и история. Создание service → проверенные порты → online. Архив не удаляет финансовую историю. Диагностика без показаний: «Нет данных». GridAdapter/max-min/ML/OCPP не включены. [Политика, тесты и приёмка](../docs/testing/operator-management-results.md). Публичный выпуск PENDING.


## Stage 4B — Operator Monitoring

PostgreSQL readings → scoped monitoring API → HTTP operator UI. Derived hourly power_measurements uses strict-adjacent-v1; missing/partial never means zero. Separate measured/allocated power, unknown Grid budget, exact settlement kopecks, simulator source, bounded keyset history and CSV. [Protocol](../docs/testing/operator-monitoring-results.md). Public acceptance is pending until release PR evidence.


## Stage 5A — shadow Grid planning

GridAdapter simulator, integer-W max-min, durable immutable planning snapshots, scoped idempotent scenario commands and separate audit. No device power changes. [Contract, tests and acceptance](../docs/testing/grid-planning-results.md). GRID_FRESHNESS_SECONDS: 5–3600 (default60). Stage 5B requires acknowledged setPower and interval-safe metering.

### Power Dispatch (5B)

По умолчанию OFF. Оператор выбирает нормальный live Grid, затем POST
`/api/operator/power/dispatch` с `{ "enabled": true }` и Idempotency-Key. Переключение
только без unfinished sessions/commands; legacy active не enroll. Worker раз в секунду
восстанавливает receipts, рассчитывает live max-min, доставляет durable setPower.
Отключение после завершения зарядок. Никаких реальных денежных/аппаратных операций.
Миграция 010 запускается обычным migrate/deploy; 001–009 неизменны.
