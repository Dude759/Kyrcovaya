# Аудит утверждений перед написанием курсовой — Stage 6B

Документы накапливались по этапам. Исторический протокол с PENDING не доказывает,
что функция отсутствует сегодня: фактический release acceptance находится в PR.
Перед переносом текста в записку сверить main SHA и реализацию. Нельзя автоматически
заменять старую оценку результатов новой: baseline6A/старые acceptance сохраняют контекст.

| Место | Старое/неоднозначное утверждение | Что использовать |
|---|---|---|
| system-architecture.md, заголовок/схема | Бронь/зарядка/ML/мощность ещё проектные; Express вызывает Python | Исправлено: 001–011, ML offline pipeline→артефакт→Node/DB; нет live Python сервиса |
| database-design.md, вводная/целевая ER | Реализованы только7 таблиц, остальные23 будущие; прогноз по станции | Исправлена вводная, добавлен отдельный ER011; целевые поля и station_id не равны действующему DDL |
| database-design.md, целевые forecast rows | source=model скрывает dataset | Исправлено примечание:011 source=synthetic, mode=historical_replay; actual отдельно |
| frontend-api-contract.md, Forecast/POST | demo/model и ближайшие сутки, POST обновляет модель | Исправлено: actual null; synthetic historical origin, GET demo; POST501 в HTTP, старый сценарий только mock |
| coursework-plan.md, ML status | Обучения/измерений не было | Исправлено: trained synthetic RF, actual NEEDS_MORE_DATA; публичный факт в PR |
| ml/README.md и stage6b-model-plan.md | Только stdlib readiness, модель ещё не обучена | Исправлено: pinned model requirements, исходный план помечен историческим, команды verify/retrain |
| README.md, runtime status | Grid/ML — следующие этапы | Исправлено: Grid simulator/Dispatch и informational RF replay реализованы |
| system-architecture.md, целевой ML раздел | Признаки станция/лимиты/погода/брони можно использовать | Требует редакции перед запиской: текущие28 признаков исключают их без as-of evidence; приложение6B уточняет |
| frontend-api-contract.md, Stage2/3 исторические блоки | Пустые bookings/sessions, POST/bookings создаёт бронь, operator foundation | Исторический contract: действующий POST/bookings закрыт; использовать OpenAPI payments/bookings/sessions/operator и stage-specific sections, переписать общий обзор перед запиской |
| database-design.md, integration_jobs/power_assignments и23 сущности | Целевые имена/поля как будто равны SQL | Сверить с фактическими grid/device/refund tables и001–011; целевую модель перенести в отдельное приложение, не выдавать за physical ER |
| system-requirements.md/backend-implementation-plan.md | Первый Foundation инкремент/проектные функции | Сохранить как исходные требования/план, дополнить матрицей «требование→реализация→тест→release», не копировать PENDING как текущий статус |
| Stage4A/4B/5A/5B appendices разных файлов | PENDING или ещё нет Grid/ML | Это срез на момент этапа, сверять release PR; готовить единый актуальный перечень перед запиской |
| docs/testing/*-results.md | Разные числа тестов/неокончательные deployment SHA | Исторические baseline не подменять. Финальный6B набор200/93/20, release SHA и ссылки — в PR6B |
| docs/analogues и personas | Гипотезы пользователей и возможности аналогов | Повторно проверить официальные источники/дату перед сдачей; не представлять персоны как проведённые интервью |
| Любой текст про «реальные станции/платежи/сеть» | Серверная симуляция может выглядеть реальной | Измерения simulator, деньги тестовые, actual означает фактическую историю имитатора; физическое оборудование/реальные деньги не подключены |

Не подтверждены и не должны попасть в выводы: точность реальной сети, денежная
экономия от ML, доверительные интервалы, независимость11634 пар, live inference,
прогноз на сегодняшнюю дату, автоматическая ML оптимизация, ONNX parity. Новые данные
и отдельная временная оценка нужны для перехода к actual network модели.
