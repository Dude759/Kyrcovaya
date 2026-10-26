# Публичная демонстрация: Stage 2B

26 октября 2026 года. Стек: GitHub Pages (React) → Render Free (Express) → Neon Free (PostgreSQL 17). Этап закрывается только после живой проверки HTTPS API и сайта; наличие коммита или статус `build succeeded` не заменяют эту проверку. [Протокол](testing/public-results.md).

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

Один web service создаётся через подключение Render, без Render Postgres, дисков, worker или платных ресурсов. Источник конфигурации живого сервиса — Render; этот документ описывает её для повторения, не является Blueprint.

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
| PUBLIC_API_URL | Публичный HTTPS URL API с суффиксом /api |
| YANDEX_MAPS_API_KEY | Публичный браузерный ключ с ограничением dude759.github.io |

Сборка добавляет таймаут 90 секунд для холодного запуска и подпись публичного учебного стенда. POST автоматически не повторяется. Приватных ключей и DATABASE_URL среди VITE-переменных нет. Если PUBLIC_API_MODE ещё не задан, прежняя публикация остаётся mock; это промежуточное состояние, не завершённый Stage 2B. После переключения HTTP ошибка сервера остаётся ошибкой с повтором, а не локальным успехом.

После изменения variables требуется новая сборка Pages. Адрес приложения: [dude759.github.io/Kyrcovaya](https://dude759.github.io/Kyrcovaya/). GitHub Pages публикует только frontend/dist и не запускает Node или PostgreSQL.

## Демонстрация и ограничения

Общие учебные аккаунты указаны на странице входа. Их email защищён от изменения в PUBLIC_DEMO; для проверки редактирования собственной почты нужно зарегистрировать отдельного водителя. Публичный smoke создаёт только вымышленные тестовые записи, не реальные персональные данные. Операторской саморегистрации нет.

Render Free засыпает после 15 минут без запросов; первое подключение может занять около минуты. У Neon Free при проверке документации указаны 1 ГБ на проект и лимит вычислений; тарифные условия могут меняться. Платные планы и обход сна периодическими пингами не включаются. На текущем этапе доступны auth, профиль, настройки, каталог и карта; бронирование/оплата/зарядка подключаются в Stage 3A/3B/3C.

Источники: [Render Web Services](https://render.com/docs/web-services), [Free](https://render.com/docs/free), [deploy lifecycle](https://render.com/docs/deploys), [секреты](https://render.com/docs/configure-environment-variables), [Neon plans](https://neon.com/docs/introduction/plans), [TLS](https://neon.com/docs/connect/connect-securely).
