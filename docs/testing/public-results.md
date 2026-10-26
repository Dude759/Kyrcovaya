# Stage 2B: протокол публичного стенда

26 октября 2026 года. Статус: **IN PROGRESS**. Локальные проверки не выдаются за проверку публичного размещения.

- Репозиторий: [Dude759/Kyrcovaya](https://github.com/Dude759/Kyrcovaya).
- PR: [№1](https://github.com/Dude759/Kyrcovaya/pull/1).
- Backend Foundation: add663d; [облачная проверка этого head](https://github.com/Dude759/Kyrcovaya/actions/runs/40322356016) — PASS.
- Новая версия для размещения: 12 backend-тестов и 50 frontend-тестов локально PASS; frontend lint/build и backend build PASS.
- Neon: проект energotransport, PostgreSQL 17, Frankfurt, Free; секреты только в защищённом окружении.
- Render, HTTPS API и переключение Pages: проверка ещё не завершена.

## Приёмка

| Проверка | Результат |
| --- | --- |
| Код отправлен в GitHub, PR создан | PASS |
| Приватные env/ключи не в Git | PASS — проверены отслеживаемые файлы и значения локальных секретов |
| CI backend и frontend текущего head | PENDING |
| PR merged в main | PENDING |
| API live, health/ready HTTPS | PENDING |
| Миграция и seed публичной БД | PENDING |
| Регистрация, дубликат email, запрет operator, login/logout | PENDING |
| Профиль/настройки после рестарта API | PENDING |
| Изоляция ролей/организаций и пустой workspace | PENDING |
| CORS Pages и отказ постороннему origin | PENDING |
| Pages использует API и настоящую карту | PENDING |

Правила и команды: [публикация](../public-demo.md). Следующие бизнес-подсистемы не включены в этот этап.
