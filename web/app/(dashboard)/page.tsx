import Link from "next/link";
import type { ReactElement } from "react";

import { BentoGrid } from "@/components/bento/BentoGrid";
import { EmptyState } from "@/components/bento/EmptyState";
import { ChannelCard } from "@/components/cards/ChannelCard";
import { ApiSummaryCards } from "@/components/cards/ApiSummaryCards";
import { CoreCard } from "@/components/cards/CoreCard";
import { E2ECard } from "@/components/cards/E2ECard";
import { HealthCard } from "@/components/cards/HealthCard";
import { StorageCard } from "@/components/cards/StorageCard";
import { WorkersCard } from "@/components/cards/WorkersCard";
import { Icon } from "@/components/icons";
import { SectionTitle } from "@/components/layout/SectionTitle";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Topbar } from "@/components/layout/Topbar";
import { ApiStatusBadge } from "@/components/states/ApiStatusBadge";
import {
  describeApiFailure,
  fetchDashboardSummary,
  fetchMailFolders,
  getApiBaseUrl,
} from "@/lib/api/client";
import type { DashboardSummary } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { mockSummaryFor, type ChannelMockSummary } from "@/lib/mock/channels";
import { STUB_SIDEBAR_LINKS, deriveOverallStatus } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

const CHANNEL_WORK_FORMATS = ["remote", "hybrid", "office"] as const;

/** Сводка канала: живые агрегаты FastAPI, при недоступности API — MOCK. */
function channelSummaryFor(
  channelId: string,
  dashboard: DashboardSummary | null,
): ChannelMockSummary {
  if (dashboard === null) {
    return mockSummaryFor(channelId);
  }

  if (channelId === "email") {
    return {
      primary: `${dashboard.mail.folders_synced} папок · ${dashboard.mail.emails_total} писем`,
      secondary: `новых: ${dashboard.mail.emails_new} · полезный спам: ${dashboard.valuable_spam.total}`,
    };
  }

  if (channelId === "vacancies") {
    const formats = CHANNEL_WORK_FORMATS.map(
      (format) => `${format} ${dashboard.vacancies.by_work_format[format] ?? 0}`,
    ).join(" · ");
    return {
      primary: `${dashboard.vacancies.active} активных из ${dashboard.vacancies.total}`,
      secondary: `игнор: ${dashboard.vacancies.ignored} · ${formats}`,
    };
  }

  if (channelId === "rzhd") {
    const price = dashboard.rzhd.cheapest_price_rub;
    return {
      primary: `${dashboard.rzhd.total} рейсов · ${dashboard.rzhd.available} с местами`,
      secondary:
        price === null
          ? `в наблюдении: ${dashboard.rzhd.watching}`
          : `от ${formatNumber(price)} ₽ · наблюдение: ${dashboard.rzhd.watching}`,
    };
  }

  return mockSummaryFor(channelId);
}

/**
 * Обзор (route group `(dashboard)` → URL `/`).
 * Bento-сетка design.md §4: 3 модуля (Email, Вакансии, РЖД) в строке,
 * ниже — карточки состояния ядра и живые агрегаты FastAPI.
 *
 * Источник данных: `GET /api/v1/dashboard/summary` + `GET /api/v1/mail/folders`.
 * Если FastAPI недоступен, страница не падает: остаются MOCK-значения,
 * а `ApiStatusBadge` показывает `API offline / fallback`.
 */
export default async function OverviewPage(): Promise<ReactElement> {
  const [snapshot, dashboardResult, foldersResult] = await Promise.all([
    loadDashboardSnapshot(),
    fetchDashboardSummary(),
    fetchMailFolders(),
  ]);

  const dashboard = dashboardResult.ok ? dashboardResult.data : null;
  const folders = foldersResult.ok ? foldersResult.data : null;
  const apiOnline = dashboardResult.ok && foldersResult.ok;
  const apiDetail = dashboardResult.ok
    ? `${getApiBaseUrl()} · ${dashboardResult.latencyMs} мс · БД ${dashboardResult.data.database.status}`
    : dashboardResult.error.kind === "offline"
      ? getApiBaseUrl()
      : describeApiFailure(dashboardResult.error);
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
        trailing={
          <div className="flex flex-wrap items-center gap-2">
            <ApiStatusBadge online={apiOnline} detail={apiDetail} />
            <StatusBadge status={deriveOverallStatus(snapshot.nav)} />
          </div>
        }
      />

      <SectionTitle hint="3 столбца на desktop · 1 на mobile">Модули</SectionTitle>
      <BentoGrid>
        {snapshot.nav.length > 0 ? (
          snapshot.nav.map((section, index) => (
            <ChannelCard
              key={section.id}
              section={section}
              summary={channelSummaryFor(section.id, dashboard)}
              revealIndex={index}
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

      <SectionTitle hint={`${getApiBaseUrl()} · /api/v1`}>Живые данные API</SectionTitle>
      <ApiSummaryCards dashboard={dashboard} folders={folders} />

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
