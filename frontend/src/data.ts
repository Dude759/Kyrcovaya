export type Connector = {
  type: "CCS2" | "CHAdeMO" | "Type 2";
  powerKw: number;
  available: number;
  total: number;
};

export type StationStatus = "available" | "busy" | "offline" | "service";

export type Station = {
  id: string;
  name: string;
  address: string;
  district: string;
  coordinates: [longitude: number, latitude: number];
  status: StationStatus;
  loadPercent: number | null;
  limitKw: number;
  pricePerKwh: number;
  connectors: Connector[];
};

export const stations: Station[] = [
  {
    id: "tverskaya-plaza",
    name: "Тверская Plaza",
    address: "ул. Тверская, 22",
    district: "Тверской район",
    coordinates: [37.6042, 55.7664],
    status: "available",
    loadPercent: 68,
    limitKw: 420,
    pricePerKwh: 18,
    connectors: [
      { type: "CCS2", powerKw: 150, available: 2, total: 4 },
      { type: "CHAdeMO", powerKw: 100, available: 1, total: 2 },
      { type: "Type 2", powerKw: 22, available: 1, total: 2 },
    ],
  },
  {
    id: "khodynka",
    name: "Заряд Ходынка",
    address: "Ходынский б-р, 4",
    district: "Хорошёвский район",
    coordinates: [37.5312, 55.7905],
    status: "available",
    loadPercent: 54,
    limitKw: 360,
    pricePerKwh: 16,
    connectors: [
      { type: "CCS2", powerKw: 120, available: 3, total: 4 },
      { type: "Type 2", powerKw: 22, available: 3, total: 4 },
    ],
  },
  {
    id: "city-hub",
    name: "Сити Hub",
    address: "Пресненская наб., 8",
    district: "Пресненский район",
    coordinates: [37.5377, 55.7472],
    status: "busy",
    loadPercent: 91,
    limitKw: 600,
    pricePerKwh: 21,
    connectors: [
      { type: "CCS2", powerKw: 250, available: 1, total: 6 },
      { type: "CHAdeMO", powerKw: 100, available: 0, total: 2 },
    ],
  },
  {
    id: "leningradskaya",
    name: "Ленинградская 14",
    address: "Ленинградское ш., 14",
    district: "Войковский район",
    coordinates: [37.4936, 55.8182],
    status: "offline",
    loadPercent: null,
    limitKw: 240,
    pricePerKwh: 17,
    connectors: [{ type: "CCS2", powerKw: 120, available: 0, total: 2 }],
  },
  {
    id: "south-terminal",
    name: "Южный терминал",
    address: "Варшавское ш., 132",
    district: "Чертаново Северное",
    coordinates: [37.6066, 55.6198],
    status: "available",
    loadPercent: 73,
    limitKw: 480,
    pricePerKwh: 17,
    connectors: [
      { type: "CCS2", powerKw: 180, available: 2, total: 4 },
      { type: "Type 2", powerKw: 22, available: 2, total: 4 },
    ],
  },
  {
    id: "river-station",
    name: "Речной вокзал",
    address: "Фестивальная ул., 2",
    district: "Левобережный район",
    coordinates: [37.4662, 55.8549],
    status: "service",
    loadPercent: 18,
    limitKw: 180,
    pricePerKwh: 15,
    connectors: [{ type: "CCS2", powerKw: 90, available: 0, total: 2 }],
  },
];

export const statusLabels: Record<StationStatus, string> = {
  available: "Доступна",
  busy: "Высокая нагрузка",
  offline: "Нет связи",
  service: "Сервис",
};

export const selectedStation = stations[0];
