export function directionsUrl([longitude, latitude]: [number, number]) {
  return `https://yandex.ru/maps/?rtext=~${latitude}%2C${longitude}&rtt=auto`;
}
