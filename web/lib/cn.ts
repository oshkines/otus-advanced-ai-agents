/**
 * Склейка className-ов без внешних зависимостей (clsx/tailwind-merge не подключаем).
 */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
