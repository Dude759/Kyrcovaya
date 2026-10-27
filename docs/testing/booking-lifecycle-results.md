# Stage 3E — Booking Cancellation & No-show

27 октября 2026. Локально **PASS**, публичная приёмка **PENDING** на момент этого
протокола. Финальные CI/SHA/Render/Pages/smoke/браузер и статус выпуска фиксируются
в PR Stage 3E. До публичной приёмки это не GREEN / CLOSED.
Исходный main: `546065ccf3ecc7d05240c7708ff045f57df8c786`.

## Политика и реализация

- Без штрафов: до подтверждённого запуска можно отменить только бронь **без любой
  когда-либо созданной сессии**. Не только отсутствие active: starting/failed/active/
  stopping/completed блокируют новый booking refund. Used не меняется на cancelled/expired.
- Окно запуска [start, min(start+15 минут, end)). Неявка наступает при PG time >=
  правой границы. Время проверяется после driver advisory → payment → station →
  connector → reservation → booking locks. POST cancel после границы фиксирует no_show.
- Одна транзакция: closure (причина/время) + cancelled/released либо expired/expired
  + отдельный полный booking_refunds intent. Оплаченный payment остаётся succeeded;
  это факт оплаты, а не активность брони. Повтор webhook не восстанавливает резерв.
- Уникальность closure/refund по booking; снимки и terminal status неизменны.
  SQL guard сериализует вставки session/closure по payment/booking и запрещает их
  совместное существование. Deferred constraints защищают оплату, порт и причину.
- Booking refund: pending → submitted → succeeded, стабильный provider ID и отдельная
  неизменяемая test_booking_refund_receipts. Ложный ответ без квитанции не завершает
  возврат. После сбоя до/после квитанции продолжается прежняя операция.
- Общий финансовый guard учитывает 3C-компенсации, стоимость/остаток 3D и возвраты
  брони 3E, включая каждую успешную попытку оплаты. Превышение реальной оплаты запрещено.
- Отказ старта 3D или stop до ack по-прежнему рассчитывается через session settlement/
  session refund. Его cancelled booking освобождает порт только после terminal receipt
  и нулевого счёта; booking refund не создаётся. 006 безопасно приводит такие прежние
  случаи к released, не меняя их финансовую историю.
- Recovery при boot/после платёжного recovery примерно раз в 15 секунд; до 20 записей
  за цикл. Driver GET workspace также восстанавливает свои записи до snapshot.
  Сон Free задерживает выполнение. Availability и текущий каталог считают порт занятым
  до фактического SQL-освобождения; любая unfinished session блокирует порт и дальше.
- React сохраняет mock. HTTP отмена требует модального подтверждения; история различает
  driver cancellation/no_show/used/session failure и pending/confirmed refund. Polling
  раздела броней раз в 5 секунд, повтор операции и reload не создают новый возврат.

## Локальные результаты

PostgreSQL 17 в Docker, отдельная `energotransport_test`, случайная схема на набор.
Race/fault/restart и исторические согласованные fixture только там, не в рабочей Neon.

```text
backend npm run check; npm run build; npm test
130 / 130 PASS = прежние 104 + L00–L25 (26 новых), около 61 секунды
frontend npm run build; npm run lint; npm test
74 / 74 PASS = прежние 68 + 6 новых UI-сценариев
```

Прежние проверки не удалены: ожидание числа миграций обновлено до 6, список таблиц
Foundation — до новой схемы. Исправлена сохранность прежней mock-подписи подтверждения.

| ID | PASS |
| --- | --- |
| L00 | Повтор 006, снимки, запрет release без закрытия и раннего no-show |
| L01 | Отмена, полная сумма, атомарный release, ожидание квитанции |
| L02 | Повтор сохраняет reason/time/refund ID |
| L03 | Параллельные отмены, одна closure/refund |
| L04 | Граница после ожидания locks; точное half-open правило |
| L05 | Автоматическая неявка и сохранность первоначального результата |
| L06 | Start против cancel: только один победитель |
| L07 | Starting после границы/offline нельзя освободить как no-show |
| L08 | Failed session получает только возврат 3D |
| L09 | Active/stopping/completed used нельзя отменить/просрочить |
| L10 | Stop до start ack — только нулевой session refund |
| L11 | Availability до/после SQL-release, новая бронь того же порта |
| L12 | Два refund workers, одна квитанция |
| L13 | Сбой до квитанции |
| L14 | Сбой после квитанции |
| L15 | Ложный ответ адаптера не подтверждает возврат |
| L16 | Общий бюджет и неизменяемая сумма |
| L17 | Rollback в середине закрытия |
| L18 | Настоящий OS restart, восстановление no-show и submitted refund |
| L19 | HTTP owner 404/operator 403, строгий payload и scope |
| L20 | Повтор success после cancellation, прежний резерв не оживает |
| L21 | SQL-вставка session после closure запрещена |
| L22 | Отмена внутри окна без штрафов |
| L23 | До границы no-show не наступает; min с end |
| L24 | Подписанные повторные события после driver/no_show не восстанавливают бронь |
| L25 | Start/no_show после ожидания границы, session не создаётся |

Шесть UI-тестов: подтверждение намерения/политика; starting; исторический failed;
ожидающий возврат; no-show с квитанцией; сетевой повтор без нового объекта.

## Миграция и публичный выпуск

006 (001–005 неизменны) применена 27 SQL-операциями одной транзакции на временной
Neon-ветке `br-rapid-mud-bazl2zsm` с данными 3D. Автоистечение 2026-10-27T13:48:38Z.
Checksum: `aa970c024326095e84145c0760d93de340e11b14c72c940c7939d86866712b77`.

После PR/CI/merge нужны автоматические Render/Pages одного SHA и
`node scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations --payments --charging --lifecycle`:
прежние 15 групп и две новые группы cancellation/refund/re-reserve. Неявка дополнительно
проверяется настоящим браузером с ожиданием полного окна 15 минут, без SQL-подмены времени.
Браузер отдельно проходит отмену и no-show, подтверждение полного возврата, reload/login/history.
Финальный read-only аудит проверяет статусы reservation, отсутствие session/booking refund
на одной брони, общий бюджет и квитанции. Итог после публикации — в PR.

## Ограничения

Только учебные деньги, без штрафов. Возврат сессии 3D не превращается в booking refund.
Нет гарантированного срока обработки во время сна Free. Workspace ограничен последними
100 бронями/сессиями, recovery — 20 записями за цикл. Реальные банки, OCPP, GridAdapter,
управление энергосистемой и ML остаются за пределами этого этапа.
