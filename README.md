# Энерготранспорт

Учебная платформа для мониторинга и управления зарядной инфраструктурой электромобилей.

[Открыть сайт](https://dude759.github.io/Kyrcovaya/)

Фронтенд: React, TypeScript и Vite. Есть отдельные кабинеты водителя и оператора, карта зарядных станций, бронирование, демонстрационная оплата и зарядка, управление мощностью и прогноз нагрузки.

## Запуск

```bash
cd frontend
npm ci
npm run dev
```

Приложение доступно по адресу `http://localhost:5173`.

## Демоаккаунты

| Роль | Почта | Пароль |
| --- | --- | --- |
| Водитель | driver@energotransport.test | Demo12345 |
| Оператор | operator@energotransport.test | Demo12345 |

На GitHub Pages используется локальный деморежим: данные хранятся в браузере посетителя, оплата не списывает деньги. Также реализован [Backend v0.1](backend/README.md): Express, PostgreSQL, серверные аккаунты, профиль и каталог. Для его подключения после запуска API выполните в `frontend/` команду `npm run dev:server` и откройте `http://localhost:5173`. Бронирование/оплата/зарядка в серверном режиме пока недоступны. Яндекс Карты подключаются через браузерный ключ с ограничением доменов; без ключа доступна демонстрационная схема.

## Документация

- [Общий план курсовой v1.2 и контрольные точки](docs/coursework-plan.md)
- [Анализ четырёх аналогов с официальными источниками](docs/analog-analysis.md)
- [Use-case: диаграмма и сценарии](docs/use-cases.md)
- [Персоны и карта боли](docs/personas-and-pain-map.md)
- [Тест-план и протоколы будущих проверок](docs/testing/test-plan.md)
- [Фронтенд и сценарии](frontend/README.md)
- [Backend v0.1: запуск, БД, seed и API](backend/README.md)
- [Фактические проверки backend](docs/testing/backend-results.md)
- [Публикация на GitHub Pages](docs/github-pages.md)
- [Контракт будущего API](docs/frontend-api-contract.md)
- [Сценарий демонстрации](docs/frontend-demo.md)
- [Требования к системе](docs/system-requirements.md)
- [Архитектура](docs/system-architecture.md)
- [Проектирование БД](docs/database-design.md)
- [Этапы реализации backend](docs/backend-implementation-plan.md)

Публикация на Pages выполняется автоматически после отправки изменений в `main`. Исходники сайта расположены в `frontend/`; конфигурация публикации — в `.github/workflows/pages.yml`.
