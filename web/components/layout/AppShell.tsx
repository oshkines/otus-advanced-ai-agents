import type { ReactElement, ReactNode } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface AppShellProps {
  readonly children: ReactNode;
  readonly sections: readonly DashboardNavSection[];
  readonly coreName: string;
  readonly coreVersion: string;
  readonly configPath: string | null;
  readonly error: string | null;
}

/** Каркас приложения: sidebar + баннер ошибки конфига + контент. */
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
        {error === null ? null : (
          <div
            role="alert"
            data-testid="config-error-banner"
            className="m-4 rounded-bento border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger lg:m-6"
          >
            <p className="font-semibold">Конфиг orchestrator.json не прочитан</p>
            <p className="mt-1 font-mono text-xs break-all">{error}</p>
            <p className="mt-2 text-xs text-danger/80">
              Подсказка: запускайте Next.js из каталога web/ или задайте переменную окружения
              ORCHESTRATOR_CONFIG_PATH.
            </p>
          </div>
        )}
        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
