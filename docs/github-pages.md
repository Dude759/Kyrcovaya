# Публикация фронтенда на GitHub Pages

Подготовлена публикация учебной демоверсии без бэкенда. Workflow запускает проверку кода, тесты и сборку, затем публикует только `frontend/dist`. Данные демонстрации сохраняются отдельно в браузере каждого посетителя. Реальная оплата и серверная авторизация появятся после подключения бэкенда.

## Настройка репозитория

1. Создать публичный репозиторий GitHub и загрузить проект, сохранив структуру: `.github/workflows/pages.yml` в корне, `frontend/` рядом. Файл `.env`, зависимости и `dist` в Git не добавлять.
2. В **Settings → Pages → Build and deployment → Source** выбрать **GitHub Actions**.
3. В **Settings → Secrets and variables → Actions → Variables** добавить переменную `YANDEX_MAPS_API_KEY` со значением браузерного ключа JavaScript API 3.0. Подпись запросов и серверный секрет здесь не нужны. Браузерный ключ будет доступен посетителю в сборке; его ограничивают разрешёнными доменами в кабинете Яндекса.
4. Отправить изменения в `main` или `master`, либо запустить **Actions → Publish frontend to GitHub Pages → Run workflow**.
5. После успешного запуска открыть ссылку из задания **deploy** или из **Settings → Pages**. Обычный адрес: `https://<логин>.github.io/<репозиторий>/`.

Workflow получает базовый путь из настроек Pages. На GitHub Pages маршруты используют фрагмент URL: `<адрес-сайта>/#/driver/stations`. Прямые ссылки и обновление страницы работают без серверного перенаправления. Локальный запуск по умолчанию сохраняет обычные адреса `/driver/stations`.

## Карта после публикации

В кабинете Яндекс Карт добавить домен опубликованного сайта в разрешённые HTTP Referer браузерного ключа, сохранив `localhost` для разработки. Настройки применяются не мгновенно. Затем открыть карту на опубликованном сайте и проверить её загрузку. Без ключа или при отказе доступа интерфейс покажет подписанную демонстрационную схему и повтор загрузки.

Изменение переменной GitHub требует нового запуска сборки. GitHub Pages не читает локальный `.env` и не запускает серверное API.

## Локальная проверка публикации

В PowerShell, из папки `frontend`:

```powershell
$env:VITE_ROUTER_MODE = 'hash'
$env:VITE_BASE_PATH = '/energotransport/'
npm run build
npm run preview
# После остановки preview (Ctrl+C):
Remove-Item Env:VITE_ROUTER_MODE
Remove-Item Env:VITE_BASE_PATH
```

Открыть `http://localhost:4173/energotransport/#/login`, войти и обновить страницу кабинета. Проверить карточку станции, бронирование, выход и вход оператора. После этого обычная команда `npm run build` снова собирает локальную версию с настройками из `.env`.

Официальные инструкции: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [публикация Vite](https://vite.dev/guide/static-deploy.html), [JavaScript API Яндекс Карт](https://yandex.ru/maps-api/docs/js-api/common/quickstart.html).
