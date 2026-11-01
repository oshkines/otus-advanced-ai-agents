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
 * sidebar остаётся альтернативным путём навигации.
 */
export function ChannelCard({ section, summary, className }: ChannelCardProps): ReactElement {
  const footerParts: string[] = [
    `воркеры: ${section.workerIds.length === 0 ? "—" : section.workerIds.join(", ")}`,
  ];
  if (section.storageTable !== null) {
    footerParts.push(`таблица: ${section.storageTable}`);
  }

  return (
    <BentoCard
      title={section.label}
      subtitle={section.href}
      href={section.href}
      testId={`channel-card-${section.id}`}
      className={cn("col-span-12 md:col-span-6 lg:col-span-4", className)}
      footer={footerParts.join(" · ")}
    >
      <div className="flex h-full flex-col justify-between gap-3">
        <div>
          <p className="text-lg font-semibold leading-tight">{summary.primary}</p>
          <p className="mt-1 text-xs text-muted">{summary.secondary}</p>
        </div>
        <StatusBadge status={section.status} className="w-fit" />
      </div>
    </BentoCard>
  );
}
