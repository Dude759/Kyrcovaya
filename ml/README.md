# Stage 6A — data readiness, не обученная ML-модель

Python **3.14.5**, только стандартная библиотека (requirements.txt намеренно без
сторонних зависимостей). Окружение: `python -m venv .venv`, затем запускать
`.venv/Scripts/python.exe` на Windows или `.venv/bin/python` на Linux.
Все команды ниже выполняются из `ml/`; CI использует ту же patch-версию Python.

```sh
python -m readiness prepare
python -m unittest discover -s tests -v
python -m readiness audit --input data/server-snapshot.json --out results/audit.json
python -m readiness export --input data/server-snapshot.json --out results/export.json
python -m readiness validate --input results/synthetic-network.json --out results/quality.json
python -m readiness baseline --input results/synthetic-network.json --out results/baseline-metrics.json
python -m readiness forecast --input results/synthetic-network.json --origin 2026-05-02T00:00:00Z --method weekly --out results/forecast.json
```

`prepare` воспроизводит зафиксированные JSON/CSV, manifests/hashes, метрики и SVG
без доступа к сети/БД. `data/server-snapshot.json` — read-only снимок настоящей
истории серверного имитатора Neon; это не реальные физические зарядные станции.
`data/server-audit.json` — отдельный аудит raw readings/session/Grid/history counts.
`results/synthetic-*` — исключительно synthetic, никогда не загружается в Neon.
`results/actual-*` — фактическая история имитатора, не synthetic и не нулевые пропуски.

Обновление снимка (из `backend/`, с уже настроенным безопасным DATABASE_URL):

```sh
node --import tsx scripts/export-ml-snapshot.mjs --org 00000000-0000-4000-8000-000000000001 --out ../ml/data/server-snapshot.json
```

Экспорт выполняет одну repeatable-read READ ONLY транзакцию с timeout 30s. Не запускает
seed, миграции, агрегацию или генератор. Токены/DSN не записываются в результаты.
При обновлении snapshot требуется новый аудит; воспроизводимый контрольный набор
в CI не обращается к изменяющейся production. Текущий снимок получен через Neon MCP
тем же SELECT; SQL лежит в `sql/export.sql`, организация параметризована.

UTC hour `end=t` обозначает среднюю мощность на `[t-1h,t)`. Forecast origin —
граница UTC часа, h=1..24 относятся к часам с end=origin+h. В actual наблюдение
доступно не раньше max(end,built_at), в synthetic — end (идеализированное допущение).
При partial/missing сетевой target и его availability равны null. Недостаток
недельной истории не маскируется persistence или нулём. Метрики сравнивают только
общие пары origin/h с complete target и обеими доступными оценками.

Train/validation/test — фиксированные half-open блоки целевых end timestamps.
Между блоками gap 24h; origin допустим только если все его 24 target часа внутри
одного блока. Последние origin предыдущего блока дополнительно отсечены горизонтом.
Baseline фиксированы до просмотра test; никакого подбора по test нет. Train-метрики
описательные, baseline ничего не обучают. Пул origin/h содержит пересекающиеся
прогнозы; это не независимые 11634 физических часа и не доверительный интервал.

Синтетический генератор независим от baseline/будущего RF. Отдельные RNG demand и
quality, физические пределы, число зарядок, max-min и эпизоды дефицита/recovery.
Латентные будущие counts/demand/noise/Grid не экспортируются в feature matrix.
Календарная связь дефекта и сезонности — учебная гипотеза, не результат исследования.
Физический ноль при известных показаниях разрешён; отсутствие показаний нулём не становится.

Отчёт: `docs/testing/ml-data-readiness-results.md`, спецификация 6B —
`docs/stage6b-model-plan.md`. Действующий frontend/API и Power Dispatch не меняются.
