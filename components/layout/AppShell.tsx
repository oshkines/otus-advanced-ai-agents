import type { ReactElement, ReactNode } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { ConfigError } from "@/components/states/ConfigError";
import { OfflineBanner } from "@/components/states/OfflineBanner";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface AppShellProps {
  readonly children: ReactNode;
  readonly sections: readonly DashboardNavSection[];
  readonly coreName: string;
  readonly coreVersion: string;
  readonly configPath: string | null;
  readonly error: string | null;
}

/**
 * Каркас приложения: sidebar + офлайн-баннер + ошибка конфига + контент.
 * Ни один из слоёв не зависит от успешного чтения конфига — это и есть
 * грациозная деградация (PRD_CHALLENGE.md §7.3).
 */
export function AppShell({
  children,
  sections,
  coreName,
  coreVersion,
  configPath,
  error,
}: AppShellProps): ReactElement {
  return (
    <div className="relative z-10 flex min-h-screen flex-col lg:flex-row">
      <Sidebar
        sections={sections}
        coreName={coreName}
        coreVersion={coreVersion}
        configPath={configPath}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        {error === null ? null : <ConfigError error={error} configPath={configPath} />}
        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

