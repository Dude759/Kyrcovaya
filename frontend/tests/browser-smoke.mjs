// Run inside the CUA REPL with an authenticated driver tab. Uses only the supplied CUA tab API.
// No browser launch, hidden application state access, account creation or real transactions.
export async function runBrowserSmoke(tab, baseUrl = "http://localhost:5173") {
  const results = [];
  const screens = [
    ["/driver/stations", "Зарядные станции"],
    ["/driver/stations/tverskaya-plaza", "Тверская Plaza"],
    ["/driver/booking?station=tverskaya-plaza", "Бронирование"],
    ["/driver/bookings", "Мои бронирования"],
    ["/driver/sessions", "Зарядные сессии"],
    ["/driver/profile", "Профиль"],
    ["/driver/settings", "Настройки"],
    ["/forgot-password", "Восстановление доступа"],
    ["/reset-password", "Новый пароль"],
    ["/login?role=operator", "Вход в систему"],
    ["/register", "Регистрация водителя"],
    ["/page-not-found", "Страница не найдена"],
  ];
  for (const [path, heading] of screens) {
    await tab.goto(baseUrl + path);
    await tab.getAXState({ emit: false });
    await tab.playwright
      .getByRole("heading", { name: heading, exact: true })
      .first()
      .waitFor({ state: "visible", timeoutMs: 10000 });
    const layout = await tab.playwright.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    if (layout.content > layout.viewport + 1)
      throw new Error(`Horizontal page overflow: ${path}`);
    results.push({ path, heading, passed: true, width: layout.viewport });
  }
  await tab.goto(baseUrl + "/operator");
  await tab.getAXState({ emit: false });
  await tab.playwright
    .getByRole("heading", { name: "Зарядные станции", exact: true })
    .waitFor({ state: "visible", timeoutMs: 10000 });
  if (!(await tab.url()).includes("/driver/stations"))
    throw new Error("Driver role guard failed");
  results.push({
    path: "/operator",
    passed: true,
    check: "Redirect driver to driver workspace",
  });
  return results;
}

export async function runOperatorSmoke(tab, baseUrl = "http://localhost:5173") {
  const results = [];
  for (const [path, heading] of [
    ["/operator", "Панель оператора"],
    ["/operator/stations", "Станции и мощность"],
    ["/operator/power", "Управление мощностью"],
    ["/operator/sessions", "Зарядные сессии"],
    ["/operator/settings", "Настройки организации"],
  ]) {
    await tab.goto(baseUrl + path);
    await tab.getAXState({ emit: false });
    await tab.playwright
      .getByRole("heading", { name: heading, exact: true })
      .waitFor({ state: "visible", timeoutMs: 10000 });
    const layout = await tab.playwright.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    if (layout.content > layout.viewport + 1)
      throw new Error(`Horizontal page overflow: ${path}`);
    results.push({ path, heading, passed: true, width: layout.viewport });
  }
  return results;
}
