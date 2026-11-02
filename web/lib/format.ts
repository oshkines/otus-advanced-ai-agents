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

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Календарных дней до ISO-даты по Europe/Moscow (UTC+3, без перехода на летнее время).
 *
 * Считается на сервере: результат не зависит от часового пояса пользователя и
 * не вызывает hydration mismatch (PRD_CHALLENGE.md US-RZ-05 AC-3).
 * Возвращает `NaN` для некорректной даты и отрицательное число для прошедшей.
 */
export function daysUntilIsoDate(iso: string, now: Date = new Date()): number {
  const targetMs = Date.parse(`${iso}T00:00:00+03:00`);
  if (Number.isNaN(targetMs)) {
    return Number.NaN;
  }

  const nowMsk = new Date(now.getTime() + MSK_OFFSET_MS);
  const todayMs =
    Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate()) - MSK_OFFSET_MS;

  return Math.round((targetMs - todayMs) / MS_PER_DAY);
}

