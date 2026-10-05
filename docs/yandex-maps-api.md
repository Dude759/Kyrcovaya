# Интеграция Yandex Maps API

Для приложения используется JavaScript API Яндекс Карт 3.0. В Figma карта представлена слоем `Yandex Maps API container`; при разработке этот слой заменяется настоящим интерактивным контейнером без изменения панели поиска, фильтров и карточки выбранной станции.

## Подключение

1. Получить ключ для продукта JavaScript API в Кабинете разработчика Яндекса. Отдельный секрет для загрузки браузерной карты не используется. Geocoder для отображения уже известных координат станций не нужен.
2. В настройках ключа заполнить «Ограничение по HTTP Referer» значением `localhost`. Открывать локальное приложение по адресу `http://localhost:5173`. Числовой адрес `127.0.0.1` кабинет Яндекса в этом поле отклоняет. Ограничение по IP-адресам для текущего браузерного подключения оставить пустым. При публикации добавить домен сайта.
3. Хранить браузерный ключ в `frontend/.env` как `VITE_YANDEX_MAPS_API_KEY`. Этот файл исключён из Git. Ключ браузерного API виден в собранном приложении, поэтому ограничения адресов обязательны. Серверные секреты в переменные `VITE_*` не записываются.
4. Загружать API со строкой `lang=ru_RU`.

После изменения `.env` Vite перезапускается; обновите страницу приложения. В кабинете разработчика указано, что изменения ограничений начинают действовать через 15–60 минут после сохранения. Проверять карту нужно после применения настроек.

Если API отвечает `403 Invalid api key`, проверьте значение ключа, продукт JavaScript API, заполнение HTTP Referer и время с момента сохранения настроек. Ошибка не означает, что нужно использовать секрет вместо ключа. На время недоступности API приложение сохраняет список станций и показывает подписанную демонстрационную схему с кнопкой повторной загрузки.

Реализация карты находится в `frontend/src/components/StationMap.tsx`, актуальный тип станции — в `frontend/src/data.ts`. Ниже приведён упрощённый пример, а не полный контракт текущего API.

```html
<script
  src="https://api-maps.yandex.ru/v3/?apikey=YOUR_API_KEY&lang=ru_RU"
></script>
```

Контейнер должен иметь явную ненулевую высоту:

```html
<div id="station-map" class="station-map"></div>
```

```css
.station-map {
  width: 100%;
  min-height: 640px;
}
```

Минимальная инициализация для Москвы:

```js
async function initStationMap(stations) {
  await ymaps3.ready;

  const {
    YMap,
    YMapDefaultSchemeLayer,
    YMapDefaultFeaturesLayer,
    YMapMarker
  } = ymaps3;

  const map = new YMap(document.getElementById('station-map'), {
    location: {
      center: [37.6176, 55.7558],
      zoom: 12
    }
  });

  map.addChild(new YMapDefaultSchemeLayer());
  map.addChild(new YMapDefaultFeaturesLayer());

  for (const station of stations) {
    const markerElement = document.createElement('button');
    markerElement.className = `station-marker station-marker--${station.status}`;
    markerElement.type = 'button';
    markerElement.ariaLabel = `${station.name}, ${station.powerKw} кВт`;
    markerElement.addEventListener('click', () => selectStation(station.id));

    map.addChild(new YMapMarker({
      coordinates: station.coordinates,
      properties: { stationId: station.id }
    }, markerElement));
  }

  return map;
}
```

## Контракт данных станции

```ts
type ChargingStation = {
  id: string;
  name: string;
  address: string;
  coordinates: [longitude: number, latitude: number];
  status: 'available' | 'busy' | 'offline';
  powerKw: number;
  availablePorts: number;
  connectors: Array<'CCS2' | 'CHAdeMO' | 'Type 2'>;
  pricePerKwh: number;
};
```

После выбора маркера приложение обновляет карточку станции поверх карты. Состояние фильтров и выбранной станции хранится в приложении; карта отвечает за подложку, позиционирование и события маркеров.

Официальная документация:

- [Быстрый старт и настройка локальной разработки](https://yandex.ru/maps-api/docs/js-api/common/quickstart.html)
- [Пример группировки маркеров](https://yandex.com/maps-api/docs/js-api/examples/cases/many-points.html)
