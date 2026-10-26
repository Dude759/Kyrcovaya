# Stage 2B: протокол публичного стенда

26 октября 2026 года. Статус публичного smoke: **PASS**. Проверки ниже выполнены против настоящего HTTPS API и опубликованного сайта; локальные тесты указаны отдельно. Закрытие Stage 2B требует также успешной публикации последнего merge, что проверяется по CI и состоянию Render.

- Репозиторий: [Dude759/Kyrcovaya](https://github.com/Dude759/Kyrcovaya).
- Основная реализация: [PR №1](https://github.com/Dude759/Kyrcovaya/pull/1), merge c2b1d01; финальная проверка и исправление роли — [PR №2](https://github.com/Dude759/Kyrcovaya/pull/2).
- Backend Foundation: add663d; [облачная проверка этого head](https://github.com/Dude759/Kyrcovaya/actions/runs/40322356016) — PASS.
- Финальная локальная версия: 12 backend-тестов и 51 frontend-тест PASS; frontend lint/build и backend build PASS. Первый публичный релиз прошёл [backend CI](https://github.com/Dude759/Kyrcovaya/actions/runs/40325237392) и [frontend CI](https://github.com/Dude759/Kyrcovaya/actions/runs/40325237518). Проверки закрывающей ревизии видны в PR №2.
- Neon: проект energotransport, PostgreSQL 17, Frankfurt, Free; секреты только в защищённом окружении.
- Приложение: [GitHub Pages](https://dude759.github.io/Kyrcovaya/), режим http. API: [health](https://energotransport-api-dude759.onrender.com/health), [ready](https://energotransport-api-dude759.onrender.com/ready).
- Render: srv-dbfko00m7kps739for2g, free, Frankfurt; первый deploy dep-dbfko10m7kps739foul0 и повторный dep-dbfkph8m7kps739ftg60 — live. [Страница сервиса](https://dashboard.render.com/web/srv-dbfko00m7kps739for2g).
- Переключение Pages на API: [публикация 40325979018](https://github.com/Dude759/Kyrcovaya/actions/runs/40325979018). PUBLIC_API_MODE=http, PUBLIC_API_URL указывает на HTTPS /api; CORS — только origin Pages.
- Ревизия bef122a после PR №2: [backend CI](https://github.com/Dude759/Kyrcovaya/actions/runs/40328129753), [frontend CI](https://github.com/Dude759/Kyrcovaya/actions/runs/40328129685) и [Pages](https://github.com/Dude759/Kyrcovaya/actions/runs/40328129737) — PASS. В публичном браузере подтверждены переход driver → operator по URL без сохранения старой роли, серверный вход и 8 станций на Яндекс Карте.
- При проверке обнаружено, что autoDeploy=yes у сервиса с публичным Git URL не запустил новый backend. Пользователь отдельно подключил GitHub к Render. Итог проверки следующего merge, live commit и повторного smoke сохраняется в [PR №3 — проверка автоматической доставки](https://github.com/Dude759/Kyrcovaya/pull/3). До успешного результата этого пункта Stage 2B не считается CLOSED.

## Приёмка

| Проверка | Результат |
| --- | --- |
| Код отправлен в GitHub, PR создан | PASS |
| Приватные env/ключи не в Git | PASS — проверены отслеживаемые файлы и значения локальных секретов |
| CI backend и frontend первой публичной версии | PASS; ссылки выше; последнее состояние закрывающей ревизии — в PR №2 |
| Основной PR merged в main | PASS — PR №1; финальное обновление — PR №2 |
| API live, health/ready HTTPS | PASS — 200, status ok/ready |
| Миграция и seed публичной БД | PASS — логи bootstrap, 7 предметных + 1 служебная таблица; 8 станций / 44 порта |
| Регистрация, дубликат email, запрет operator, login/logout | PASS — 201 / 409 / 400 / 200 / 204; отозванный токен даёт 401 |
| Истёкший токен | PASS — истечены только токены созданного данным smoke QA-пользователя, me возвращает 401 |
| Профиль/настройки после рестарта API | PASS — после live повторного deploy старый токен работает, battery=82, receipts=false |
| Изоляция ролей/организаций и пустой workspace | PASS — водитель получает 403 для operator; QA-оператор другой организации не видит станций и получает 404 на чужие детали/порты; массивы пусты, forecast=null |
| CORS Pages и отказ постороннему origin | PASS — точный allow-origin для Pages, 403 для untrusted.example |
| Pages использует API и настоящую карту | PASS — вход водителя/оператора через сервер, 8 объектов каталога, настоящая подложка и подпись Яндекса |

Правила и команды: [публикация](../public-demo.md). Следующие бизнес-подсистемы не включены в этот этап.

## Воспроизведение и источники доказательств

Автоматический smoke — [public-smoke.mjs](../../backend/scripts/public-smoke.mjs), синтетическая вторая организация — [public-fixture.sql](../../backend/scripts/public-fixture.sql). Интерактивный прогон завершён с девятью PASS-группами. QA-пользователь public-smoke-1793019001114@example.test создан с вымышленными данными и случайным паролем; его токены/пароль не записывались в файлы. Сначала сохранены профиль/настройки, затем API повторно развёрнут на том же commit, подтверждена сохранность; только после этого для этих QA-сессий принудительно выставлено истечение. Основные демоаккаунты при проверке не отзывались и не меняли пароль.

Для проверки межорганизационного доступа создана дополнительная пустая QA-организация с одним оператором, без станций и без влияния на публичную карту. Основной seed по-прежнему содержит одну рабочую учебную сеть. Публичные запросы не используют отдельную тестовую PostgreSQL из CI и не очищают рабочую БД.

В CUA проверены публичная главная, серверный вход водителя и оператора, карта, карточка с отключённым бронированием. Найдено сохранение прежней роли формы при изменении URL; роль теперь берётся из URL, добавлен регрессионный тест. Отдельная защита не позволяет менять email общих демоаккаунтов. В браузере нет переключения на локальный успех при ошибке API.

## Ограничения

Это функциональная приёмка учебного стенда, не нагрузочный эксперимент и не аудит безопасности. Банковских платежей, оборудования, ML и серверных бронирований пока нет. Render Free имеет холодный старт. Никакие периодические пинги для обхода сна или платные планы не включены. Правила завершения последующих этапов: код в main, актуальные сайт/API и сохранённый публичный smoke.
