# Публичная демонстрация: Foundation, Reservation Core, Test Payments

26 октября 2026 года. Стек: GitHub Pages (React) → Render Free (Express) → Neon Free (PostgreSQL 17). [Приложение](https://dude759.github.io/Kyrcovaya/), [API health](https://energotransport-api-dude759.onrender.com/health), [протокол](testing/public-results.md). Этап закрывается только после живой проверки API и сайта; наличие коммита или build succeeded не заменяют эту проверку.

## Правило завершения этапов

После каждого стабильного инкремента:

1. Выполнить tests/lint/build; сохранить фактические результаты.
2. Проверить Git на приватные `.env`, ключи, URL с паролями и лишние файлы.
3. Commit → push в `codex/...` → PR в `main`.
4. Дождаться успешных backend и frontend проверок текущего head; затем merge.
5. Дождаться публикации сайта и, при изменении сервера, состояния live у API.
6. Проверить публичный сценарий, CORS и постоянное хранение.
7. Сохранить ссылки на commit/PR/CI, версию deploy и результат smoke; только тогда CLOSED.

До публикации допустима отметка `GREEN (local)`. Основная ссылка преподавателя использует HTTP API, а mock остаётся отдельным локальным режимом. При ошибке API автоматического переключения на mock нет.

## Настройки Render

Web service energotransport-api-dude759 создан в подтверждённой области «курсовая», без Render Postgres, дисков, worker или платных ресурсов. Источник конфигурации живого сервиса — Render; этот документ описывает её для повторения, не является Blueprint. Service ID: srv-dbfko00m7kps739for2g. Автопубликация настроена для main.

Одного значения autoDeploy=yes недостаточно для приёмки. Сервис, созданный по публичному Git URL, сначала нужно связать с GitHub через Repository в настройках Render. После подключения проверяется следующий merge: в истории Render должен появиться deploy с тем же commit, причиной автоматического запуска и итогом live. Ручной redeploy проверяет сохранность данных, но не доказывает работу автоматической доставки. Итог этой проверки фиксируется в связанном с [публичным протоколом](testing/public-results.md) PR.

Дополнительное условие — установленное GitHub App Render с доступом к Kyrcovaya. Вход в Render через GitHub и поле Git Credentials сами по себе не подтверждают установку приложения. Проверка: GitHub → Settings → Applications → Installed GitHub Apps → Render → Configure → Repository access. Достаточно разрешить один репозиторий Kyrcovaya. В данном стенде отсутствие Render в Installed GitHub Apps было обнаружено по скриншоту пользователя; после установки проводится новый выпуск через PR. Deploy Hook остаётся секретом и для этой схемы не нужен.

| Настройка | Значение |
| --- | --- |
| Репозиторий / ветка | Dude759/Kyrcovaya / main |
| Регион / план | Frankfurt / free |
| Runtime | Node.js 24 |
| Build command | `cd backend && npm ci --include=dev && npm run build` |
| Start command | `cd backend && exec node dist/src/deploy.js` |
| Host / port | HOST=0.0.0.0; PORT задаёт Render |
| CORS_ORIGINS | https://dude759.github.io — origin, без пути /Kyrcovaya/ |
| NODE_ENV | production |
| TRUST_PROXY_HOPS | 1 — ближайший прокси Render; локально 0 |
| PUBLIC_DEMO / DEPLOY_SEED | true / true |
| DATABASE_URL / DATABASE_URL_UNPOOLED | Только в защищённом окружении Render, с sslmode=verify-full |
| SEED_OPERATOR_PASSWORD / SEED_DRIVER_PASSWORD | Пароли исключительно учебных аккаунтов; не пароль БД |

На Free нет pre-deploy command, поэтому `deploy.js` сначала применяет миграции и повторяемый seed, закрывает служебный пул, затем запускает API в том же процессе. Ошибка bootstrap завершает процесс до открытия порта. Seed не сбрасывает существующие профили и пароли. Для нового этапа добавляется новая миграция; старые файлы не переписываются. Хеширование выполняется по одному scrypt за раз с ограниченной очередью, чтобы поместиться в память бесплатного экземпляра.

Neon создан отдельным проектом `energotransport`, production-ветка, PostgreSQL 17, AWS Frankfurt, организация на Free. Для миграций используется прямое соединение; у текущего endpoint pooler выключен, поэтому небольшой постоянный `pg.Pool` приложения также использует прямой URL. Пароль и URL в этот документ не копируются. Локальная Docker-БД не заменяется облачной и не выгружается в неё: на публичном стенде только seed и учебные проверки.

## Публикация frontend

Workflow Pages читает несекретные GitHub repository variables:

| Переменная | Значение |
| --- | --- |
| PUBLIC_API_MODE | http — выставляется после успешного smoke API |
| PUBLIC_API_URL | https://energotransport-api-dude759.onrender.com/api |
| YANDEX_MAPS_API_KEY | Публичный браузерный ключ с ограничением dude759.github.io |

Сборка добавляет таймаут 90 секунд для холодного запуска и подпись публичного учебного стенда. POST автоматически не повторяется. Приватных ключей и DATABASE_URL среди VITE-переменных нет. Если PUBLIC_API_MODE ещё не задан, прежняя публикация остаётся mock; это промежуточное состояние, не завершённый Stage 2B. После переключения HTTP ошибка сервера остаётся ошибкой с повтором, а не локальным успехом.

После изменения variables требуется новая сборка Pages. Адрес приложения: [dude759.github.io/Kyrcovaya](https://dude759.github.io/Kyrcovaya/). GitHub Pages публикует только frontend/dist и не запускает Node или PostgreSQL.

## Демонстрация и ограничения

Общие учебные аккаунты указаны на странице входа. Их email защищён от изменения в PUBLIC_DEMO; для проверки редактирования собственной почты нужно зарегистрировать отдельного водителя. Публичный smoke создаёт только вымышленные тестовые записи, не реальные персональные данные. Операторской саморегистрации нет.

Вторая пустая организация и qa.operator@energotransport.test предназначены только для проверки изоляции: у них нет станций. Воспроизводимая подготовка — [public-fixture.sql](../backend/scripts/public-fixture.sql), основной прогон — `node backend/scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com`. Режим `--interactive` останавливается после сохранения профиля для контролируемого redeploy, затем после проверки сохранности — для истечения только созданных этим прогоном QA-токенов. Секретные Bearer-токены и случайный пароль остаются в памяти процесса. В отчёте фиксируются только статусы и синтетический email.

Render Free засыпает после 15 минут без запросов; первое подключение может занять около минуты. У Neon Free при проверке документации указаны 1 ГБ на проект и лимит вычислений; тарифные условия могут меняться. Платные планы и обход сна периодическими пингами не включаются. Доступны auth, профиль, настройки, каталог, карта, availability и Test Payments. Подтверждённая бронь — 3C, серверная зарядка — 3D.

Источники: [Render Web Services](https://render.com/docs/web-services), [Free](https://render.com/docs/free), [deploy lifecycle](https://render.com/docs/deploys), [секреты](https://render.com/docs/configure-environment-variables), [Neon plans](https://neon.com/docs/introduction/plans), [TLS](https://neon.com/docs/connect/connect-securely).

## Платёжный инкремент 3B

В Render заданы PAYMENT_PUBLIC_ORIGIN=https://energotransport-api-dude759.onrender.com и приватный PAYMENT_WEBHOOK_SECRET (случайный ключ подписи). Секрет хранится только в окружении API, не в VITE/Git/логах. Обе переменные нужны одновременно; настройки БД и остальные env сохраняются.

Приёмка: `node backend/scripts/public-smoke.mjs https://energotransport-api-dude759.onrender.com --reservations --payments`. Прогон проверяет create/idempotency, fail/retry/cancel, HTTPS форму, повтор success, отсутствие booking и expiry. Capability URL и токены остаются в памяти. Вымышленные заказы сохраняются; hold освобождается или истекает. [Протокол 3B](testing/payment-results.md). Основной переход оформления брони закрыт до 3C.
