/** Форматирование дат для UI (серверный рендер, локаль ru-RU). */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Europe/Moscow",
  });
}

/** Число с разделителем разрядов (для цен и счётчиков). */
export function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU");
}
