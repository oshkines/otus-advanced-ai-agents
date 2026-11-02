import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { cn } from "@/lib/cn";
import type { ChannelMockSummary } from "@/lib/mock/channels";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface ChannelCardProps {
  readonly section: DashboardNavSection;
  readonly summary: ChannelMockSummary;
  readonly className?: string;
}

/**
 * Карточка канала на обзоре. Клик по карточке ведёт в раздел (п.4.1 DISCUSS.md),
 * sidebar остаётся альтернативным путём навигации (нужен для AC-3: страница
 * канала открывается, даже когда воркера нет).
 *
 * Пока в канале нет включённого воркера (`enabled: false` → `disabled`, либо
 * воркер не описан в `workers[]` → `not_connected`), карточка переходит в
 * визуальное состояние `not_connected`: приглушённый серый текст, ссылка не
 * рендерится (клики заблокированы), причина дописана в footer. Семантический
 * статус не подменяется — его по-прежнему показывает StatusBadge
 * (`data-status="disabled"` для `enabled: false`, см. PRD_CHALLENGE.md AC-1).
 */
export function ChannelCard({ section, summary, className }: ChannelCardProps): ReactElement {
  const inactive = section.status !== "active";
  const visualState = inactive ? "not_connected" : "active";

  const footerParts: string[] = [
    `воркеры: ${section.workerIds.length === 0 ? "—" : section.workerIds.join(", ")}`,
  ];
  if (section.storageTable !== null) {
    footerParts.push(`таблица: ${section.storageTable}`);
  }
  if (inactive) {
    footerParts.push("переход заблокирован");
  }

  return (
    <BentoCard
      title={section.label}
      subtitle={section.href}
      href={section.href}
      inactive={inactive}
      state={visualState}
      testId={`channel-card-${section.id}`}
      className={cn("col-span-12 md:col-span-6 lg:col-span-4", className)}
      footer={footerParts.join(" · ")}
    >
      <div className="flex h-full flex-col justify-between gap-3">
        <div>
          <p
            className={cn(
              "text-lg font-semibold leading-tight",
              inactive ? "text-muted" : "text-ink",
            )}
          >
            {summary.primary}
          </p>
          <p className="mt-1 text-xs text-muted">{summary.secondary}</p>
        </div>
        <StatusBadge status={section.status} className="w-fit" />
      </div>
    </BentoCard>
  );
}
