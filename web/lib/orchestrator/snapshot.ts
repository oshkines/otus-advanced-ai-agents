import { getDashboardSource } from "./source";
import type { DashboardSnapshot } from "./types";

/**
 * Точка входа для Server Components: всегда возвращает модель, даже при битом конфиге
 * (ошибка уходит в `snapshot.error` и показывается баннером, страница не падает).
 */
export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  return getDashboardSource().load();
}
