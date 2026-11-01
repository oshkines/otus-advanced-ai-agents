import Link from "next/link";
import type { ReactElement } from "react";

import { BentoGrid } from "@/components/bento/BentoGrid";
import { EmptyState } from "@/components/bento/EmptyState";
import { ChannelCard } from "@/components/cards/ChannelCard";
import { CoreCard } from "@/components/cards/CoreCard";
import { E2ECard } from "@/components/cards/E2ECard";
import { HealthCard } from "@/components/cards/HealthCard";
import { StorageCard } from "@/components/cards/StorageCard";
import { WorkersCard } from "@/components/cards/WorkersCard";
import { Icon } from "@/components/icons";
import { SectionTitle } from "@/components/layout/SectionTitle";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Topbar } from "@/components/layout/Topbar";
import { mockSummaryFor } from "@/lib/mock/channels";
import { STUB_SIDEBAR_LINKS, deriveOverallStatus } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

/**
 * Обзор (route group `(dashboard)` → URL `/`).
 * Bento-сетка design.md §4: 3 модуля (Email, Вакансии, РЖД) в строке,
 * ниже — карточки состояния ядра. Данные каналов пока MOCK (до Phase 6).
 */
export default async function OverviewPage(): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();
  const config = snapshot.config;

  if (config === null) {
    return (
      <>
        <Topbar title="Обзор" subtitle="Конфиг orchestrator.json недоступен" />
        <p className="mt-6 rounded-bento border border-border bg-surface p-4 text-sm text-muted">
          Без конфига bento-сетка не строится: список каналов берётся из
          ui.dashboard.navigation. Подробности ошибки — в баннере выше.
        </p>
      </>
    );
  }

  const channelLabels = snapshot.nav.map((section) => section.label).join(", ");

  return (
    <>
      <Topbar
        title="Обзор"
        subtitle={`${config.core.name} · конфиг v${config.version}${
          channelLabels.length > 0 ? ` · каналы: ${channelLabels}` : ""
        }`}
        trailing={<StatusBadge status={deriveOverallStatus(snapshot.nav)} />}
      />

      <SectionTitle hint="3 столбца на desktop · 1 на mobile">Модули</SectionTitle>
      <BentoGrid>
        {snapshot.nav.length > 0 ? (
          snapshot.nav.map((section) => (
            <ChannelCard
              key={section.id}
              section={section}
              summary={mockSummaryFor(section.id)}
            />
          ))
        ) : (
          <EmptyState
            testId="channels-empty"
            title="Система в режиме ожидания. Новых событий не обнаружено"
            hint="Каналы не описаны в ui.dashboard.navigation — ниже заглушки модулей из резервной навигации."
          >
            <ul className="mt-3 flex flex-wrap justify-center gap-2">
              {STUB_SIDEBAR_LINKS.map((link) => (
                <li key={link.id}>
                  <Link
                    href={link.href}
                    className="inline-flex items-center gap-2 rounded-control border border-border bg-canvas px-3 py-1.5 text-xs leading-4 text-muted transition-colors hover:border-primary/50 hover:text-ink"
                  >
                    <Icon name={link.icon} width={14} height={14} />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </EmptyState>
        )}
      </BentoGrid>

      <SectionTitle hint={`источник данных: ${snapshot.sourceId}`}>Система</SectionTitle>
      <BentoGrid>
        <CoreCard
          config={config}
          sourceId={snapshot.sourceId}
          generatedAtIso={snapshot.generatedAtIso}
        />
        <HealthCard config={config} sections={snapshot.nav} />
        <WorkersCard workers={config.workers} statuses={snapshot.statuses} />
        <StorageCard config={config} />
        <E2ECard config={config} />
      </BentoGrid>
    </>
  );
}
