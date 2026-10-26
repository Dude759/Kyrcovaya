# Энерготранспорт

Учебная платформа для мониторинга и управления зарядной инфраструктурой электромобилей.

[Открыть приложение](https://dude759.github.io/Kyrcovaya/) · [Запустить локально](backend/README.md)

[Проверить публичный API](https://energotransport-api-dude759.onrender.com/health)

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

Основное приложение на GitHub Pages подключено к Express API на Render и PostgreSQL 17 в Neon. Сервер обслуживает регистрацию/вход, профиль, настройки, каталог из восьми станций и 44 физических портов. Данные общие и сохраняются после перезапуска API; настоящая Яндекс Карта строится по каталогу БД. Stage 3B добавляет тестовый платёж с удержанием порта и подписанными событиями. Деньги не списываются; подтверждённая бронь, зарядка, телеметрия и ML относятся к следующим этапам. Первый запрос после простоя может занять около минуты.

Локальный полный mock остаётся отдельным режимом для проверки будущих сценариев; при ошибке публичного API сайт не подменяет серверные данные локальной демонстрацией. Для локального сервера — [инструкция Backend v0.3](backend/README.md) и `npm run dev:server` из frontend. До Stage 3C основной переход оформления брони закрыт: success провайдера фиксируется на попытке, платёж остаётся pending без booking.

## Документация

- [Публичная демонстрация и правило завершения этапов](docs/public-demo.md)
- [Stage 2B: публичный протокол](docs/testing/public-results.md)
- [Stage 3A: Reservation Core и проверка PostgreSQL-конкуренции](docs/testing/reservation-results.md)
- [Stage 3B: Test Payments и протокол P00–P19](docs/testing/payment-results.md)
- [Общий план курсовой v1.5 и контрольные точки](docs/coursework-plan.md)
- [Анализ четырёх аналогов с официальными источниками](docs/analog-analysis.md)
- [Use-case: диаграмма и сценарии](docs/use-cases.md)
- [Персоны и карта боли](docs/personas-and-pain-map.md)
- [Тест-план и протоколы будущих проверок](docs/testing/test-plan.md)
- [Фронтенд и сценарии](frontend/README.md)
- [Backend v0.3: запуск, БД, seed и API](backend/README.md)
- [Фактические проверки backend](docs/testing/backend-results.md)
- [Публикация на GitHub Pages](docs/github-pages.md)
- [Контракт будущего API](docs/frontend-api-contract.md)
- [Сценарий демонстрации](docs/frontend-demo.md)
- [Требования к системе](docs/system-requirements.md)
- [Архитектура](docs/system-architecture.md)
- [Проектирование БД](docs/database-design.md)
- [Этапы реализации backend](docs/backend-implementation-plan.md)

Публикация на Pages выполняется автоматически после отправки изменений в `main`. Исходники сайта расположены в `frontend/`; конфигурация публикации — в `.github/workflows/pages.yml`.
