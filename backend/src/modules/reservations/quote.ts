export function quote(
  powerKw: number,
  durationMinutes: number,
  batteryKwh: number,
  tariffKopecks: number,
) {
  const energyKwh =
    Math.round(
      Math.min(((powerKw * durationMinutes) / 60) * 0.65, batteryKwh * 0.3) *
        1000,
    ) / 1000;
  return { energyKwh, amountKopecks: Math.round(energyKwh * tariffKopecks) };
}
