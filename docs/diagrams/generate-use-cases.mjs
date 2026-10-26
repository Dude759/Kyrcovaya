import { writeFileSync } from 'node:fs';

// Run: node docs/diagrams/generate-use-cases.mjs
// Pure SVG keeps the diagram editable and independent of Figma or rendering packages.
const driver = [
  ['D01', 'Зарегистрироваться'],
  ['D02', 'Найти совместимую станцию'],
  ['D03', 'Забронировать и оплатить'],
  ['D04', 'Просмотреть / отменить бронь'],
  ['D05', 'Начать / завершить зарядку'],
  ['D06', 'Посмотреть историю и отчёт'],
  ['D07', 'Профиль и уведомления'],
];
const operator = [
  ['O01', 'Наблюдать состояние сети'],
  ['O02', 'Управлять станциями и портами'],
  ['O03', 'Контролировать сессии'],
  ['O04', 'Задать лимиты мощности'],
  ['O05', 'Получить прогноз нагрузки'],
  ['O06', 'Перевести объект в сервис'],
  ['O07', 'Организация и оповещения'],
];

const ellipse = (id, label, x, y) => `<g id="${id}">
  <ellipse cx="${x}" cy="${y}" rx="235" ry="36" fill="white" stroke="#24303b" stroke-width="1.8"/>
  <text x="${x}" y="${y - 9}" text-anchor="middle" font-size="14" fill="#61707e">${id}</text>
  <text x="${x}" y="${y + 15}" text-anchor="middle" font-size="21" fill="#18232e">${label}</text>
</g>`;
const actor = (x, name) => `<g aria-label="${name}" fill="none" stroke="#24303b" stroke-width="2.5" stroke-linecap="round">
  <circle cx="${x}" cy="384" r="20"/>
  <path d="M ${x} 404 V 473 M ${x - 36} 433 H ${x + 36} M ${x} 473 L ${x - 29} 516 M ${x} 473 L ${x + 29} 516"/>
  <text x="${x}" y="551" text-anchor="middle" font-size="23" stroke="none" fill="#18232e">${name}</text>
</g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1040" viewBox="0 0 1600 1040" role="img" aria-labelledby="title desc">
<title id="title">Варианты использования платформы «Энерготранспорт»</title>
<desc id="desc">Два актора: водитель и оператор. Оба входят в систему. Водитель регистрируется, ищет станцию, бронирует и оплачивает, управляет своей зарядкой и историей. Оператор наблюдает сеть, управляет объектами, сессиями, мощностью и прогнозом. Публичная регистрация оператора отсутствует. Это целевая модель, а не перечень реализованных серверных функций.</desc>
<rect width="1600" height="1040" fill="white"/>
<g font-family="Segoe UI, Arial, sans-serif">
  <text x="54" y="49" font-size="16" fill="#61707e">ПРОЕКТИРОВАНИЕ · ВАРИАНТЫ ИСПОЛЬЗОВАНИЯ</text>
  <rect x="235" y="90" width="1130" height="870" rx="0" fill="#fafbfc" stroke="#24303b" stroke-width="2"/>
  <text x="800" y="131" text-anchor="middle" font-size="26" font-weight="600" fill="#18232e">Платформа «Энерготранспорт»</text>
  <g fill="none" stroke="#687582" stroke-width="1.4">
    <path d="M 126 433 L 184 200 H 565 M 1474 433 L 1416 200 H 1035"/>
    ${driver.map((_, i) => `<path d="M 126 433 L 305 ${325 + i * 90}"/>`).join('\n    ')}
    ${operator.map((_, i) => `<path d="M 1474 433 L 1295 ${325 + i * 90}"/>`).join('\n    ')}
  </g>
  ${ellipse('C01', 'Войти в систему', 800, 200)}
  ${driver.map(([id, label], i) => ellipse(id, label, 540, 325 + i * 90)).join('\n  ')}
  ${operator.map(([id, label], i) => ellipse(id, label, 1060, 325 + i * 90)).join('\n  ')}
  ${actor(90, 'Водитель')}
  ${actor(1510, 'Оператор')}
  <text x="800" y="1001" text-anchor="middle" font-size="17" fill="#61707e">Целевая модель · линии показывают участие акторов · оператор получает аккаунт служебным способом</text>
</g>
</svg>
`;
writeFileSync(new URL('./use-cases.svg', import.meta.url), svg, 'utf8');
