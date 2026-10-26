# Проектирование базы данных

Версия 1.1, 26 октября 2026 года. Целевая логическая схема PostgreSQL. Первые семь таблиц реализованы в [001_foundation.sql](../backend/migrations/001_foundation.sql) и проверены на PostgreSQL 17; остальная модель и SQL резервирования ниже ещё не реализованы. Дополнительная schema_migrations — технический журнал, не восьмая предметная сущность.

## Принципы

Строковый UUID по умолчанию используется для новых сущностей. Для станций допускается стабильный текстовый ID, чтобы сохранить существующие ссылки `tverskaya-plaza` и другие. Ключи API остаются строками. Время — `timestamptz`, измерения — `numeric` с явными единицами, денежные суммы — `bigint` в копейках, валюта — RUB в первой версии. Связи задаются внешними ключами; финансовая история не удаляется каскадно.

Текущий `Connector` во frontend — группа портов одного типа/мощности. Строка БД `connectors` — **один конкретный независимо резервируемый порт**. Несколько выходов с общей аппаратной мощностью потребуют отдельного ограничения зарядного устройства; для первой версии имитатора выходы считаются независимыми в пределах лимита станции.

## Основные связи

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ USERS : employs
    ORGANIZATIONS ||--o{ STATIONS : owns
    USERS ||--o| DRIVER_PROFILES : has
    USERS ||--|| USER_PREFERENCES : has
    USERS ||--o{ AUTH_SESSIONS : signs_in
    USERS ||--o{ PASSWORD_RESET_TOKENS : requests
    STATIONS ||--o{ CONNECTORS : contains
    USERS ||--o{ PAYMENTS : creates
    PAYMENTS ||--o{ PAYMENT_ATTEMPTS : retries
    PAYMENTS ||--o{ PAYMENT_EVENTS : receives
    PAYMENTS ||--o{ REFUNDS : refunds
    PAYMENTS ||--o| BOOKINGS : confirms
    CONNECTORS ||--o{ CONNECTOR_RESERVATIONS : reserves
    PAYMENTS ||--o| CONNECTOR_RESERVATIONS : holds
    BOOKINGS ||--|| CONNECTOR_RESERVATIONS : confirms
    USERS ||--o{ BOOKINGS : owns
    BOOKINGS ||--o| CHARGING_SESSIONS : starts
    CONNECTORS ||--o{ CHARGING_SESSIONS : serves
    CHARGING_SESSIONS ||--o{ SESSION_MEASUREMENTS : measures
    STATIONS ||--o{ POWER_MEASUREMENTS : aggregates
    ORGANIZATIONS ||--o{ GRID_SAMPLES : receives
    ORGANIZATIONS ||--o{ FORECAST_RUNS : forecasts
    FORECAST_RUNS ||--o{ LOAD_PREDICTIONS : contains
    STATIONS ||--o{ LOAD_PREDICTIONS : predicts
    CHARGING_SESSIONS ||--o{ POWER_ASSIGNMENTS : controls
    ORGANIZATIONS ||--o{ NETWORK_EVENTS : audits
    ORGANIZATIONS ||--o{ INTEGRATION_JOBS : dispatches
```

Связь `bookings → connector_reservations` обязательна для подтверждённой брони. До оплаты существует удержание без брони. В `load_predictions.station_id` допускается NULL для прогноза всей сети. Кратность ER показывает бизнес-связи; составные ограничения ниже уточняют их.

## Словарь таблиц

| Таблица | Основные поля | Назначение и ограничения |
| --- | --- | --- |
| organizations | id, name, network_limit_kw, created_at | Организация-владелец сети; лимит ≥ 0 |
| users | id, email_normalized, password_hash, name, phone, role, organization_id, disabled_at, created_at | UNIQUE email; role driver/operator; у оператора обязательна организация, роль меняется только служебной операцией |
| driver_profiles | user_id, vehicle_name, plate, preferred_connector_type, battery_capacity_kwh | Один текущий автомобиль водителя; ёмкость 10–250 кВт⋅ч; отсутствие профиля оператора нормально |
| user_preferences | user_id, booking_alerts, receipts, network_alerts, critical_alerts, load_alerts, reports | Один набор предпочтений на пользователя |
| auth_sessions | id, user_id, token_hash, expires_at, revoked_at, created_at | UNIQUE хеш; токен в открытом виде не хранится |
| password_reset_tokens | id, user_id, token_hash, expires_at, used_at, revoked_at | UNIQUE хеш; один действующий токен на пользователя обеспечивает сервис под блокировкой пользователя |
| stations | id, organization_id, name, address, district, longitude, latitude, max_power_kw, limit_kw, price_per_kwh_kopecks, operating_state, archived_at | Координаты longitude ±180, latitude ±90; 0 ≤ limit ≤ max; state online/offline/service; доступность вычисляется отдельно |
| connectors | id, station_id, label, type, max_power_kw, operating_state, archived_at | type CCS2/CHAdeMO/Type 2; UNIQUE (station_id,label); состояние idle/offline/service, занятость определяется сессией |
| payments | id, user_id, station_id, requested_connector_type, start_at, end_at, method, amount_kopecks, quoted_tariff_kopecks, quoted_energy_kwh, status, idempotency_key, request_hash, expires_at, created_at | Один неизменяемый заказ оплаты; UNIQUE (user_id,idempotency_key); состояние pending/succeeded/failed/cancelled |
| payment_attempts | id, payment_id, attempt_no, provider, provider_payment_id, status, confirmation_url, created_at | Повтор оплаты создаёт попытку, а не новый заказ; UNIQUE (payment_id,attempt_no), UNIQUE (provider,provider_payment_id) при наличии ID |
| payment_events | id, attempt_id, provider, provider_event_id, kind, received_at, processed_at | UNIQUE (provider,provider_event_id); сохраняются только нужные поля события без карточных данных |
| connector_reservations | id, payment_id, booking_id, connector_id, start_at, end_at, state, expires_at | Состояния held/confirmed/released/expired; один диапазон одного порта; payment_id UNIQUE, booking_id UNIQUE при наличии |
| bookings | id, user_id, station_id, connector_id, payment_id, start_at, end_at, amount_kopecks, status, created_at | payment_id UNIQUE; состояния confirmed/cancelled/used/expired; duration вычисляется из интервала |
| charging_sessions | id, booking_id, user_id, station_id, connector_id, started_at, ended_at, state, initial_soc, target_soc, battery_capacity_kwh, tariff_kopecks, start_meter_kwh, final_meter_kwh, energy_kwh, cost_kopecks | booking_id UNIQUE; состояния starting/active/stopping/completed/failed; снимки автомобиля/тарифа; одна незавершённая сессия на порт и пользователя |
| refunds | id, payment_id, session_id, amount_kopecks, reason, status, provider_refund_id, idempotency_key, created_at | session_id nullable при отмене/сбойной брони; состояния pending/succeeded/failed; UNIQUE ключ; сумма успешных и ожидающих возвратов не выше оплаченной суммы |
| session_measurements | id, session_id, sequence_no, measured_at, received_at, cumulative_energy_kwh, power_kw, soc_percent, connection, source | UNIQUE (session_id,sequence_no); source simulator/device; SOC nullable; фактические и запрошенные мощности не смешиваются |
| power_measurements | id, station_id, interval_start, interval_end, avg_power_kw, energy_kwh, active_sessions, station_limit_kw, network_budget_kw, source, quality | Агрегаты часовых интервалов для обучения; UNIQUE (station_id,interval_start,source); quality complete/partial/missing |
| grid_samples | id, organization_id, available_power_kw, base_load_kw, status, measured_at, received_at, source | Снимок внешнего бюджета; source simulator/external; статус normal/constrained/offline |
| forecast_runs | id, organization_id, generated_at, origin_at, model_version, dataset_version, dataset_source, metrics, training_from, training_to, test_from, test_to | Успешные расчёты; метрики JSONB с единицами/горизонтом/базовым методом; dataset_source measured/simulator/synthetic указывает происхождение набора. DTO source=model требует фактического запуска обученной модели; сведения о наборе добавляются отдельно |
| load_predictions | id, run_id, station_id, time, horizon_hours, power_kw | 24 последовательных точки на выбранный объект; power ≥ 0; уникальность сети и станции задаётся раздельными индексами |
| power_assignments | id, session_id, grid_sample_id, forecast_run_id, requested_kw, allocated_kw, applied_kw, created_at, acknowledged_at, status, reason | allocated — решение, applied — подтверждение устройства; applied nullable до ответа; статус pending/applied/failed |
| network_events | id, organization_id, station_id, actor_user_id, date, severity, action, message, metadata | Аудит изменений и интеграционных ошибок; актор nullable для фонового обработчика |
| integration_jobs | id, organization_id, kind, operation_key, entity_id, payload, status, attempt_count, available_at, locked_until, last_error, created_at | UNIQUE operation_key; сохранённые задания оплаты/возврата/запуска/остановки/мощности; секреты в payload не сохраняются |

Эти 23 таблицы вводятся несколькими миграциями по этапам. В первом backend нужны пользователи, организации, станции, порты и настройки; ML и внешние команды добавляются тогда, когда реализуются соответствующие процессы.

## Конкурентное резервирование

Для одного порта запрещены пересекающиеся интервалы со state held/confirmed. Оба типа находятся в **одной таблице**, иначе два независимых ограничения на платежи и брони не исключат конфликт между ними.

Проект ограничения для будущей миграции:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE connector_reservations
  ADD CONSTRAINT reservation_end_after_start CHECK (end_at > start_at),
  ADD CONSTRAINT reservation_no_overlap
  EXCLUDE USING gist (
    connector_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (state IN ('held', 'confirmed'));
```

Интервалы полуоткрытые: 12:00–13:00 и 13:00–14:00 не конфликтуют. В predicate нельзя использовать `now()` для автоматического исключения просроченных удержаний. Фоновый процесс и транзакция новой заявки явно переводят истёкшие held → expired; затем ограничение перестаёт учитывать строку. Пока очистка не прошла, возможен консервативный отказ, но двойного резерва нет.

Создание, освобождение и подтверждение удержаний одной станции используют согласованный порядок блокировок: платёж → станция → порт → резерв. В пути создания нового платежа платёж сначала вставляется/находится по ключу и блокируется, затем выбираются станция и порт. Все конкурирующие пути соблюдают этот порядок. Уникальность и exclusion constraint остаются последней защитой. Deadlock/serialization conflict обрабатывается ограниченным повтором транзакции.

Сервис проверяет, что connector.station_id, payment.station_id и booking.station_id совпадают и принадлежат разрешённой организации. Для sessions `(booking_id,user_id,connector_id,station_id)` защищается составным FK на уникальную комбинацию bookings. Такие же согласованные составные связи нужны при связывании резерва с бронью. Одних независимых FK на каждый ID недостаточно.

## Индексы и неизменяемая история

- users: UNIQUE email_normalized; auth_sessions: UNIQUE token_hash и индекс по user_id; сброс пароля: user_id/expires_at.
- stations: organization_id, archived_at; connectors: station_id и тип. При исходном масштабе фильтры координат работают без PostGIS. Геопоиск большого каталога — последующее расширение.
- bookings: (user_id,start_at DESC), (station_id,start_at); sessions: (user_id,started_at DESC), (station_id,state).
- sessions: частичные UNIQUE connector_id и user_id для starting/active/stopping. Для восстановления после сбоя не создаётся вторая строка: продолжается та же операция.
- reservations: GiST для пересечений; (state,expires_at) для очистки held; UNIQUE payment_id и booking_id.
- measurements: (session_id,measured_at), (station_id,interval_start); grid_samples: (organization_id,measured_at DESC).
- predictions: UNIQUE (run_id,station_id,time) WHERE station_id IS NOT NULL; UNIQUE (run_id,time) WHERE station_id IS NULL. Обычный UNIQUE с nullable station_id не защищает сетевые точки от дублей.
- jobs: (status,available_at); журнал: (organization_id,date DESC).

Станции и порты, имеющие историю, архивируются. Тариф и ёмкость батареи фиксируются в сессии; изменение профиля или тарифа не пересчитывает прошлую зарядку. Счётчик источника никогда не заменяется клиентским временем. Возврат является отдельной записью, а не отрицательной энергией.

## Состояния и вычисляемые данные

`Station.status` совместимого DTO вычисляется: service/offline при таком operating_state; available/busy по доступным портам и фактической нагрузке. При свежей нагрузке ≥ 85% станционного лимита — busy; отсутствие idle-портов также busy. Нет свежего измерения — loadPercent = null, а не 0. Статус доступности не является гарантией свободного будущего интервала.

Доступный порт **сейчас**: станция и порт работают, порт не занят незавершённой сессией и не удерживается/не забронирован на текущий интервал. Доступный порт **на выбранное время** дополнительно не имеет пересечения с held/confirmed резервом. Актуальная сессия без подтверждённой остановки блокирует порт независимо от окончания её броневого интервала.

Количество available/total для frontend агрегируется по `(type,max_power_kw)`; суммарная свободная мощность не хранится отдельным «истинным» полем. Её считают из свежего бюджета, лимитов и измерений; при отсутствии свежих показаний она неизвестна.

Внутренние состояния expired/starting/stopping/failed и источник simulator богаче текущего DTO. Перед использованием этих состояний HTTP frontend расширяется; нельзя выдавать starting как active или simulator как настоящее device.

## Обязательные проверки будущих миграций

Две конкурентные заявки, соседние интервалы, истечение удержания, повтор webhook, поздняя оплата после освобождения порта, чужой connector_id, повтор запуска, параллельная остановка, изменение тарифа/профиля во время зарядки, повтор измерения, некорректная последовательность энергии, ограничения двух организаций и восстановление после рестарта.

DDL-пример резервирования основан на [официальной документации PostgreSQL об ограничениях диапазонов](https://www.postgresql.org/docs/17/rangetypes.html); его реализация — следующий этап. Первая миграция и её [результаты проверки](testing/backend-results.md) покрывают только Foundation.
