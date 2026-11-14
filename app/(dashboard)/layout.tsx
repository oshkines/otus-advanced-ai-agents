import type { ReactElement, ReactNode } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

// Конфиг читается на сервере при каждом запросе (вариант A: Config-SSR).
// Флаг стоит на layout группы, поэтому публичные маршруты вне `(dashboard)`
// (например, `/overview`) остаются статическими и дешевле на деплое.
export const dynamic = "force-dynamic";

export interface DashboardLayoutProps {
  readonly children: ReactNode;
}

/**
 * Layout дашборда: sidebar, офлайн-баннер, баннер ошибки конфига и контент.
 * `AppShell` рендерится только для маршрутов группы `/`, `/email`, `/vacancies`,
 * `/rzhd` — публичная MVP-страница `/overview` живёт без сайдбара.
 */
export default async function DashboardLayout({
  children,
}: DashboardLayoutProps): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();

  return (
    <AppShell
      sections={snapshot.nav}
      coreName={snapshot.config?.core.name ?? "ai-dev-orchestrator-core"}
      coreVersion={snapshot.config?.version ?? "—"}
      configPath={snapshot.configPath}
      error={snapshot.error}
    >
      {children}
    </AppShell>
  );
}
