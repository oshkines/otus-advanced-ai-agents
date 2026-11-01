import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

import "./globals.css";

import { AppShell } from "@/components/layout/AppShell";
import { AuroraBackdrop } from "@/components/layout/AuroraBackdrop";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

// Конфиг читается на сервере при каждом запросе (вариант A: Config-SSR).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  applicationName: "AI Dev Navigator",
  title: {
    default: "AI Dev Navigator — Dashboard",
    template: "%s — AI Dev Navigator",
  },
  description: "AI Dev Navigator: bento-дашборд оркестратора — Email, Вакансии, РЖД",
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();

  return (
    <html lang="ru">
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <AuroraBackdrop />
        <AppShell
          sections={snapshot.nav}
          coreName={snapshot.config?.core.name ?? "ai-dev-orchestrator-core"}
          coreVersion={snapshot.config?.version ?? "—"}
          configPath={snapshot.configPath}
          error={snapshot.error}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
