# ML workspace — Stage 6A readiness и Stage 6B RandomForest

Python **3.14.5**. Readiness использует стандартную библиотеку; модель требует
requirements-model.txt (pinned scikit-learn/NumPy/SciPy/joblib). Окружение: `python -m venv .venv`, затем запускать
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
`docs/stage6b-model-plan.md`. Интеграция Stage6B описана ниже; Power Dispatch от неё не зависит.

## Stage 6B — обученная модель, offline replay

```sh
python -m pip install --only-binary=:all: -r requirements-model.txt
python -m model.train verify --retrain
python -m unittest discover -s tests -v
```

Доверенная модель и provenance: `models/rf-v1/`; полный отчёт со всеми 24 горизонтами:
[ml-model-results](../docs/testing/ml-model-results.md). 28 признаков определены
в `model/features.py`, train-only median imputer и RF 64/10/20, seed20261101.
Dataset/splits Stage6A неизменны. Selection по validation сохранён до оценки test;
CI повторяет frozen опыт, не подбирает параметры заново по test.

Точный запуск: `python -m model.train train --out artifacts/new-experiment` создаёт
новый локальный опыт. Не заменяет trusted release: новый generatedAt изменит bundle
checksum. Для новой публикации нужны проверка результатов и review allowlist.
Joblib загружается только из фиксированного repo path после проверки доверенных
version/checksum/dataset/features/versions; пользовательские файлы не принимаются.

Render остаётся Node.js: вариант B отдаёт исторический synthetic replay Python-модели
для origin 2026-05-02T00:00:00Z, не новый прогноз сегодня. 24 points сохраняются
отдельно от телеметрии. API проверяет bundle checksum и сравнивает DB points с Python.
Actual сеть: NEEDS_MORE_DATA, forecast=null. Нет динамического Python/ONNX inference,
forecast jobs или воздействия на Grid. Synthetic test RF MAE53.527863/RMSE75.715506
кВт; weekly116.180936/159.357780 на тех же11634 парах — не качество реальной сети.
