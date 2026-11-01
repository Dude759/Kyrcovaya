# Stage 6B: план до обучения

Данные и splits Stage6A неизменны; hash synthetic 2f39bfa1271973d03c3231ec148b7c868afa5f94730d8895e654480ddac9583e.
Direct origin/h строки; все лаги и окна относительно origin, available_at<=origin.
SimpleImputer median fit только train, явные missing indicators. Будущие Grid,
брони/сессии и postfactum outcomes исключены. Random state20261101, n_jobs1.
Сетка заранее: 32 дерева/depth8/leaf20;64/depth10/leaf20;64/depth12/leaf10.
Выбор по validation MAE; конфигурация сохраняется до чтения test labels. После
фиксации test оценивается однократно; CI только воспроизводит зафиксированный опыт.

Render Node runtime не предполагает Python. ONNX требует дополнительного converter
и native Node runtime, проверок версий/платформ и parity. Для этого инкремента выбран
разрешённый вариант B: проверенный checksum версионированного Python offline forecast,
исторический origin и generatedAt сохраняются буквально. Это replay, не динамический
inference. Нет POST «обновить расчёт». Новый опыт выпускается после Python pipeline/CI.
Сам обученный trusted joblib сохраняется с manifest/hash и replay controls; Node
не загружает pickle. Долговечные forecast_runs/load_predictions в новой011 хранят
отдельный synthetic эксперимент, без изменений meters/Grid/финансов. Scope организации
обязателен; рабочая сеть NEEDS_MORE_DATA/forecast null, demo отдельным явным запросом.
