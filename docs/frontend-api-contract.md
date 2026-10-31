# Контракт API фронтенда «Энерготранспорт»

Контракт описывает текущий интерфейс и целевой сервер. На 26 октября 2026 года [Backend v0.1](../backend/README.md) реализует auth/register/login/me/logout, profile, preferences, stations и workspace. Остальные бизнес-операции ниже остаются планом и пока возвращают 501; серверных demo-маршрутов нет. Источник типов: `frontend/src/types/domain.ts`, адаптер: `frontend/src/services/api.ts`.

Базовый адрес задаётся в `VITE_API_BASE_URL` (по умолчанию `/api`). Тела и ответы — JSON. После входа клиент отправляет `Authorization: Bearer <token>`. Все даты — ISO 8601 с часовым поясом, интерфейс отображает московское время. Мощность — кВт, энергия — кВт⋅ч, деньги — рубли.

Ошибка: `{ "message": "Понятное описание ошибки" }` и корректный HTTP-статус: 400 для некорректного ввода, 401 для отсутствующего/просроченного токена, 403 для роли без доступа, 404 для недоступного объекта, 409 для конфликта состояния. Для успешной операции без ответа — 204. Ролевые ограничения и принадлежность сущностей обязательно проверяет сервер независимо от клиентских маршрутов.

## Авторизация и настройки

| Метод и путь           | Запрос                                 | Ответ                                                           |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------- |
| POST `/auth/login`     | `{email,password,role}`                | `AuthResult`: `{user,token}`                                    |
| POST `/auth/register`  | `Registration`: `Profile` + `password` | `AuthResult`, роль только driver                                |
| GET `/auth/me`         | —                                      | `User`                                                          |
| POST `/auth/logout`    | —                                      | 204, отзыв текущего токена                                      |
| PATCH `/auth/password` | `{current,next}`                       | 204, проверка текущего пароля                                   |
| PATCH `/profile`       | `Profile`                              | Обновлённый `User`                                              |
| PATCH `/preferences`   | `Partial<Preferences>`                 | `Preferences`                                                   |
| POST `/auth/recovery`  | `{email}`                              | `{message}` — нейтральный ответ, независимо от наличия аккаунта |
| POST `/auth/reset`     | `{token,password}`                     | 204, смена пароля и отзыв входов                                |

`Profile` водителя: `name`, `email`, `phone`, `vehicle`, `plate`, `connector` (CCS2, CHAdeMO или Type 2), `battery` (10–250). У operator только `name`, `email`, `phone`, `id`, `role`, автомобильные поля отсутствуют. Клиентское изменение профиля не может изменять роль или ID. Операторских пользователей создаёт администратор вне публичной регистрации. Регистрация возвращает 201; email нормализуется trim/lowercase. Смена пароля и почтовое восстановление не реализованы в v0.1.

`Preferences`: boolean-поля `bookingAlerts`, `receipts`, `networkAlerts`, `criticalAlerts`, `loadAlerts`, `reports`. Фронтенд сохраняет предпочтения; доставка уведомлений и расписание отчётов реализуются отдельно на сервере.

## Рабочая область

GET `/workspace` → `Snapshot`:

```ts
{
  stations: Station[];
  bookings: Booking[];
  sessions: Session[];
  preferences: Preferences;
  networkLimit: number;
  organization: string;
  events: NetworkEvent[];
  forecast: Forecast | null;
  payments?: Payment[];
}
```

Водитель получает свои брони/сессии; оператор — доступные ему объекты организации и их сессии. `events` — журнал оператора. Историю при росте объёма нужно перевести на отдельные пагинируемые запросы.

В v0.1 `bookings`, `sessions`, `payments`, `events` пусты, `forecast=null`, дополнительное поле `stage="foundation"` включает ограничения UI. Каталог водителя общий, оператора — только его организация. `networkLimit` и `organization` для operator берутся из БД, для driver равны 0 и пустой строке: водитель не владеет организацией. `loadPercent=null` без измерений; состояние/число доступных портов отражают конфигурацию учебного стенда.

Реализованный каталог `GET /stations` возвращает `{items:Station[],nextCursor:string|null}`; фильтры `q`, `connector`, `minPowerKw`, `availableOnly`, `limit` (1–200), `cursor`. Для публичной главной допускается запрос без Bearer; при переданном operator-токене выборка ограничена его организацией. `GET /stations/:id` возвращает Station, `GET /stations/:id/connectors` — физические `{id,stationId,label,type,maxPowerKw,operatingState}`. В Station добавлено необязательное `maxPowerKw`; группы Connector по-прежнему агрегируются по типу и мощности. Публичная главная использует анонимный каталог, защищённые кабинеты — workspace.

`Station` описан в `frontend/src/data.ts`: `id`, `name`, `address`, `district`, `coordinates: [longitude,latitude]`, `status: available|busy|offline|service`, `loadPercent: number|null`, `limitKw`, `pricePerKwh`, `connectors`. Разъём: `{type,powerKw,available,total}`. Время в пути не выдумывается: карточка открывает маршрут в Яндекс Картах по координатам назначения, без передачи местоположения пользователя в ссылке.

`NetworkEvent`: `{id,stationId: string|null,date,message,severity: info|warning|danger}`.

`Forecast`: `{source: demo|model, generatedAt, points: {time,powerKw}[]}`. Значения упорядочены по времени, неотрицательны, покрывают ближайшие сутки. При отсутствии модели возвращается `null` или явно обозначенный источник demo. Фронтенд не генерирует фиктивные метрики точности модели.

## Бронирование и зарядка

| Метод и путь                | Запрос                                         | Ответ                 |
| --------------------------- | ---------------------------------------------- | --------------------- |
| POST `/bookings`            | `{stationId,connector,start,duration,payment}` | `Booking`             |
| POST `/bookings/:id/cancel` | —                                              | Отменённый `Booking`  |
| POST `/sessions`            | `{bookingId}`                                  | Начатый `Session`     |
| POST `/sessions/:id/stop`   | —                                              | Завершённый `Session` |

`Booking`: `id`, `userId`, `stationId`, `connector`, `start`, `duration` (30/45/60/90 минут), `amount` (предварительная сумма), `payment` (card/sbp), `status` (confirmed/cancelled/used), `createdAt`. Сервер проверяет время, наличие разъёма, пересечения, принадлежность брони и повторные операции. Локальный сервис консервативно резервирует свободный порт до отмены или конца зарядки; промышленный сервер должен учитывать интервалы доступности и истечение неиспользованных броней.

`Session`: `id`, `userId`, `bookingId`, `stationId`, `connector`, `startedAt`, `meteredAt`, `batteryCapacity`, `endedAt: string|null`, `energy`, `power`, `initialCharge`, `targetCharge`, `tariff`, `status: active|completed`.

В деморежиме `energy` — накопленная энергия на момент `meteredAt`; клиент считает прибавку от текущей мощности до целевого заряда. При изменении мощности фиксируется накопленная энергия и обновляется `meteredAt`, исходное `startedAt` сохраняется. `batteryCapacity` фиксируется при старте, чтобы последующее изменение автомобиля не меняло историю. При подключении оборудования истинную энергию и биллинг должен определять сервер по показаниям счётчика; локальную симуляцию следует заменить серверной телеметрией.

В режиме HTTP интерфейс использует отдельный объект платежа (описан ниже). Реальный успех и создание брони подтверждает сервер после webhook платёжного провайдера. Текущий экспорт — отчёт CSV, не фискальный чек.

## Управление инфраструктурой

Доступно только оператору.

| Метод и путь                   | Запрос                                | Ответ     |
| ------------------------------ | ------------------------------------- | --------- |
| PATCH `/operator/stations/:id` | `{limitKw?:number, service?:boolean}` | `Station` |
| PATCH `/operator/network`      | `{networkLimit}`                      | 204       |
| PATCH `/operator/organization` | `{name}`                              | 204       |

Лимит станции 120–600 кВт с шагом 20. Лимит сети 2000–8000 кВт и не меньше суммарных лимитов объектов. Нельзя включать сервисный режим при активных сессиях. Изменения режима и мощности фиксируются в журнале. Реальное управление зарядными контроллерами требует серверного шлюза и подтверждения команды оборудованием.

## Что потребуется добавить на серверном этапе

База данных, серверное управление сессиями авторизации, платежи и возвраты, восстановление пароля, отправка уведомлений, телеметрия оборудования, ML-прогноз и управление энергосистемой. Клиентский слой готов к этому контракту, но прямое переключение переменной окружения не создаёт эти сервисы.

## Восстановление доступа

Одноразовая ссылка действует 30 минут. Повторный запрос отзывает предыдущую ссылку; применение ссылки отзывает все входы пользователя. Истёкший или использованный код возвращает 410. Сервер должен ограничивать частоту запросов, хранить хеш кода, отправлять ссылку доверенного домена по почте и не раскрывать существование аккаунта. Публичная регистрация по-прежнему создаёт только водителя.

В локальном деморежиме ответ дополнительно содержит `demoResetToken`: интерфейс открывает тестовую ссылку без отправки письма. В HTTP-режиме такая ссылка не показывается. Демо-механизм не является серверной системой безопасности.

## Платежи

| Метод и путь                | Запрос                                  | Ответ                             |
| --------------------------- | --------------------------------------- | --------------------------------- |
| POST `/payments`            | HTTP: `{input: BookingInput}`, Idempotency-Key в заголовке; mock: прежний ключ в теле | `Payment`, ожидающий оплаты |
| GET `/payments/:id`         | —                                       | `Payment`, только своему водителю |
| POST `/payments/:id/retry`  | HTTP: пустое тело и Idempotency-Key retry | Обновлённый `Payment`             |
| POST `/payments/:id/cancel` | —                                       | `Payment` со статусом cancelled   |

`Payment`: `{id,userId,input,amount,status,bookingId,createdAt,expiresAt,failure,confirmationUrl?}`. `status`: pending/succeeded/failed/cancelled; `bookingId` и `failure` могут быть `null`. `confirmationUrl` — HTTPS-страница платёжного провайдера. Карточные реквизиты не вводятся и не сохраняются в приложении.

**HTTP v0.3 / Stage 3B:** [OpenAPI](../backend/openapi/payments.yaml). Текущие business status — только pending/failed/cancelled; succeeded выше остаётся для mock и будущей 3C. Добавлены amountKopecks, tariffKopecks, estimatedEnergyKwh, test, attempt, reservation, providerSuccessReceived, awaitingFinalization, reconciliationRequired. Успех attempt не создаёт booking: payment.pending + awaitingFinalization + bookingId=null; UI это явно показывает и не предлагает повторно платить. Истёкший/поздний success требует будущей сверки. Цена из серверного immutable snapshot; неизвестные поля/карточные данные отклоняются. Workspace в 3B сохраняет пустые payments; конкретный заказ доступен владельцу через GET. Signed webhook и страница тестового адаптера отделены от пользовательского Bearer API; POST /bookings остаётся закрытым.

В HTTP v0.3 опрос прекращается после providerSuccessReceived; вместо брони показывается ожидание финализации. Следующее описание относится к полному mock и целевому процессу 3C. Интерфейс опрашивает ожидающий платёж каждые 5 секунд. Повторное создание с тем же `idempotencyKey` возвращает прежний платёж; повторное подтверждение успешной оплаты сохраняет один `bookingId` и одно резервирование разъёма. Сервер должен атомарно проверять цену, доступность и время, сверять webhook провайдера и обрабатывать конфликт брони после платежа вместе с возвратом средств. Пользователь может вернуться к незавершённой оплате через `Snapshot.payments`. В деморежиме ожидание ограничено 15 минутами и временем начала брони; ожидающие/отклонённые платежи не резервируют разъём, бронь создаётся только после тестового успеха. Прямой POST `/bookings` остаётся совместимым с прежним контрактом для локальных тестов; в реальном сервере подтверждение оплаченной брони должно происходить только через платёжный процесс.

POST `/demo/payments/:id` с `{outcome: succeeded|failed}` используется исключительно локальным симулятором. В HTTP-режиме кнопки имитации исхода скрыты; production-сервер не должен реализовывать этот маршрут.

## Телеметрия и прогноз

`Session.telemetry?: {source: demo|device,receivedAt,connection: online|offline,energy}` — последнее полученное показание. Если данные старше минуты, некорректно датированы или отсутствуют, интерфейс показывает устаревшее состояние; при `offline` — потерю связи. Тогда он сохраняет последнюю энергию, скрывает текущую мощность и время до завершения. Реальные `device`-показания никогда не экстраполируются. Демо-симуляция растёт только при свежих данных; итоговую энергию при остановке фиксирует локальный симулятор.

POST `/operator/forecast` → `Forecast|null` обновляет прогноз. Во время запроса видна загрузка; ошибка оставляет предыдущий расчёт с предупреждением и повтором. Расчёт старше часа отмечается как устаревший. Источник `demo/model` указан явно. Точность, интервал обновления и достаточность исходных данных модели — ответственность будущего backend.

Только mock: POST `/demo/sessions/:id/telemetry` с `{connection: online|offline}`; сценарий `ready/error/empty/stale` для `/operator/forecast`. В HTTP-режиме имитационные параметры и элементы управления не используются.

При ошибке первоначальной загрузки доступен повтор. При неудаче фонового обновления уже открытая рабочая область остаётся видимой с предупреждением; телеметрия самостоятельно переходит в устаревшее состояние. Ошибка 401 завершает вход.

## Проектные дополнения для backend

Поля выше отражают текущий frontend. Целевая архитектура и расширения описаны в [архитектуре](system-architecture.md), [схеме БД](database-design.md) и [плане реализации](backend-implementation-plan.md). В v0.2 реализованы health, stations, stations/:id и availability; CRUD, grid и прогноз остаются будущими расширениями. Точный контракт нового endpoint — [OpenAPI Stage 3A](../backend/openapi/reservations.yaml).

| Метод и путь | Назначение | Доступ |
| --- | --- | --- |
| GET `/health` | Живость процесса; состояние БД отдельно через readiness | Публично, без внутренних деталей |
| GET `/stations` | Каталог: `q`, `connector`, `minPowerKw`, `availableOnly`, пагинация | Водитель/оператор; организация ограничивает операторскую выборку |
| GET `/stations/:id` | Карточка доступной станции | Водитель/оператор |
| GET `/stations/:id/availability` | `start`, `duration`, `connector`; число доступных физических портов на интервал, серверная оценка цены и срок действия оценки | Водитель |
| POST `/operator/stations` | Создание станции с координатами, установленной мощностью и тарифом | Оператор своей организации |
| PATCH `/operator/stations/:id` | Расширение текущего PATCH: название/адрес/координаты/тариф/лимит/сервис; не заменяет старые поля | Оператор своей организации |
| POST `/operator/stations/:id/connectors` | Добавление физического порта с меткой, типом и мощностью | Оператор своей организации |
| PATCH `/operator/connectors/:id` | Параметры порта и сервисный режим, проверка активных резервов и зарядок | Оператор своей организации |
| POST `/operator/stations/:id/archive` | Архивирование без удаления истории; отказ при активных сессиях и будущих резервах | Оператор своей организации |
| POST `/operator/connectors/:id/archive` | Архивирование порта с теми же проверками | Оператор своей организации |
| GET `/grid/status` | Последний бюджет организации, время получения, status и source simulator/external | Оператор своей организации |
| GET `/operator/forecast` | Последний сохранённый прогноз; POST того же пути выполняет обновление | Оператор своей организации |
| POST `/integrations/payments/:provider/events` | Подписанные события тестового/банковского адаптера; deduplication по ID события | Адаптер; подпись, не пользовательский Bearer |

Успешное создание — 201, изменение — 200 или согласованный 204. Истории возвращают `items` и cursor следующей страницы; `/workspace` первоначально остаётся совместимым агрегатом. Новые структуры описываются в OpenAPI на этапе реализации, вместе с проверкой запросов и ответов. Параметры поиска не заменяют серверную проверку резервирования.

Для backend `POST /payments` получает тот же вход, но временно удерживает конкретный порт. Это **целевое отличие от mock**, где pending-платёж ничего не резервирует. Оплата должна завершиться до меньшего из 15 минут и времени начала брони. Внешний callback атомарно превращает удержание в бронь; поздний успех с конфликтом запускает возврат. `POST /bookings` не используется для обхода платежа: в первом платёжном backend он отклоняется, создание оплаченной брони — внутренняя операция сервисного слоя.

Внутренние состояния booking expired, session starting/stopping/failed, refund pending/succeeded/failed и телеметрия simulator требуют явного расширения frontend. Текущее ограничение лимита станции 120–600 и сети 2000–8000 — правила демоверсии, а не целевого оборудования. Установленная мощность, операторский лимит, доступный сетевой бюджет и фактическая нагрузка хранятся/возвращаются раздельно.

## HTTP v0.4 — текущая финализация 3C

[OpenAPI](../backend/openapi/payments.yaml), [протокол](testing/booking-finalization-results.md). Этот раздел заменяет временную границу HTTP v0.3 выше: provider success с действующим held атомарно даёт payment.succeeded, reservation.confirmed и единственную booking. bookingId заполнен; подтверждённая бронь не исчезает по старому expiresAt платежа. Прямой POST /bookings остаётся 501.

Driver workspace: stage=bookings, собственные payments и bookings (по 100 последних), sessions/events пустые, forecast=null. Booking дополнен paymentId, reservationId, connectorId; amount — предварительная тестовая сумма, не окончательная стоимость энергии. Operator workspace остаётся foundation без чужой водительской истории.

Payment дополнен finalizationReason и refunds[{id,status,reason,amount,confirmedAt,test}]. Refund pending/submitted не выполнен; succeeded допустим только при квитанции test adapter. Поздний success не восстанавливает резерв. requiresReconciliation снимается после подтверждения всех компенсаций, история причины остаётся. Checkout продолжает чтение незавершённого результата и возврата, обновляет workspace и переходит к своим броням. Reload, повторный login и возврат к pending доступны из workspace. Зарядка и отмена confirmed booking ещё закрыты.

## Реализованное расширение 0.5 — Stage 3D

Актуальный [OpenAPI Sessions](../backend/openapi/sessions.yaml) дополняет платежный контракт. POST sessions принимает строго `{bookingId}`, POST sessions/:id/stop — `{}`; оба требуют Idempotency-Key (16–128 разрешённых символов). Владелец driver создаёт команды, operator только читает свою организацию. GET sessions/:id возвращает согласованный снимок, чужой ID — 404. POST bookings по-прежнему 501.

Статусы starting/active/stopping/completed/failed. 202 означает сохранённую команду, а не подтверждённую работу устройства. startConfirmedAt — единственное фактическое начало; legacy startedAt до ack содержит requestedAt для совместимости. Поля source=simulator, soc/initialCharge/targetCharge=null, socSource=unknown; energyWh, energy (кВт⋅ч), currentPowerKw (nullable), telemetry.connection/receivedAt/sequenceNo/gap. >60 секунд currentPowerKw=null, последняя energy остаётся. UI не экстраполирует её клиентским таймером.

settlement содержит finalCostKopecks/unusedKopecks/prepaidKopecks/energyWh/tariffKopecks/reason. refund отдельно содержит amountKopecks и pending/submitted/succeeded/confirmedAt/test=true. Предоплата не является окончательной энергостоимостью. GET workspace: charging=true, последние 100 sessions (свои driver/organization operator), прежний stage=bookings/foundation сохранён. React опрашивает GET во время команды/работы/ожидающего возврата, повторяет чтение после сетевой ошибки и восстанавливает session по URL после reload/login. Отдельный mock остаётся прежним.

Правило старта [start, min(start+15 минут, end)), локальная мощность и ограничения [зафиксированы в протоколе](testing/charging-results.md).

## Реализованный контракт 0.6 — Stage 3E

[OpenAPI Bookings](../backend/openapi/bookings.yaml): POST bookings/:id/cancel, owner driver, пустое тело, повтор по ID возвращает прежний результат. Чужой ID 404, operator 403, любая существовавшая session/used 409. После границы окна сервер фиксирует expired/no_show, даже если POST ожидал locks. POST bookings без оплаты остаётся 501.

Booking DTO дополнен expired, closureReason(driver/no_show/session/null), closedAt, sessionId/sessionStatus и refund(id,amountKopecks,pending/submitted/succeeded,confirmedAt,test=true). Session-причина использует session refund, а не поле booking refund. Workspace восстанавливает собственные no-show/refund перед snapshot. UI требует подтверждения отмены, различает причину и квитанцию, обновляет историю/каталог через API. Mock сохранён. [Политика и ограничения](testing/booking-lifecycle-results.md).

## Stage 4A — управление станциями оператора

Миграция 007, аудит network_events и ключи operator_requests; API управления собственной организацией, физические порты, безопасные лимиты/режим/архив, HTTP формы и история. Создание service → проверенные порты → online. Архив не удаляет финансовую историю. Диагностика без показаний: «Нет данных». GridAdapter/max-min/ML/OCPP не включены. [Политика, тесты и приёмка](testing/operator-management-results.md). Публичный выпуск PENDING.


## Stage 4B — Operator Monitoring

PostgreSQL readings → scoped monitoring API → HTTP operator UI. Derived hourly power_measurements uses strict-adjacent-v1; missing/partial never means zero. Separate measured/allocated power, unknown Grid budget, exact settlement kopecks, simulator source, bounded keyset history and CSV. [Protocol](testing/operator-monitoring-results.md). Public acceptance is pending until release PR evidence.


## Stage 5A — shadow Grid planning

GridAdapter simulator, integer-W max-min, durable immutable planning snapshots, scoped idempotent scenario commands and separate audit. No device power changes. [Contract, tests and acceptance](testing/grid-planning-results.md). GRID_FRESHNESS_SECONDS: 5–3600 (default60). Stage 5B requires acknowledged setPower and interval-safe metering.

## Power Dispatch 5B

GET /operator/power/dispatch: enabled=false по умолчанию, status off/pending/acknowledged/
rejected/degraded; grid budget nullable, acknowledgedW — последнее durable подтверждение,
withinBudget nullable при OFF. sessions различает requestedW, plannedW, command.targetW/
status, acknowledgedW/effectiveAt, measuredW nullable, reconciliation. История содержит
бюджет/расчёт/подтверждение на момент расчёта, а не вымышленную телеметрию.
POST тот же путь, strict {enabled:boolean}, Idempotency-Key; 409 при незавершённых
сессиях/командах, unsafe Grid либо training. Перед стартом managed API проверяет
свежий Grid и headroom; GET /sessions дополняется powerControl. Обновление страницы
читает сервер; целевые значения никогда не становятся acknowledged до квитанции.
