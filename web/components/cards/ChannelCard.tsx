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
  /** Позиция в bento-сетке: задаёт задержку появления карточки. */
  readonly revealIndex?: number;
}

/**
 * Карточка канала на обзоре. Клик по карточке всегда ведёт в раздел
 * (п.4.1 DISCUSS.md), а sidebar остаётся альтернативным путём навигации:
 * страница канала открывается даже при выключенном воркере.
 *
 * Раньше неактивный канал (`enabled: false` → `disabled`, либо воркер не описан
 * в `workers[]` → `not_connected`) блокировал переход: рендерился не `<Link>`,
 * а `<section aria-disabled>` с `cursor-not-allowed`. Это оказалось вредным UX —
 * при живом API разделы открывались, но карточки выглядели «перечёркнутыми».
 * Теперь навигация не блокируется никогда: состояние канала по-прежнему
 * показывает StatusBadge (`data-status`), а выключенный воркер отмечается
 * приглушённым текстом и подсказкой в footer.
 */
export function ChannelCard({
  section,
  summary,
  className,
  revealIndex = 0,
}: ChannelCardProps): ReactElement {
  const inactive = section.status !== "active";
  const visualState = inactive ? "not_connected" : "active";

  const footerParts: string[] = [
    `воркеры: ${section.workerIds.length === 0 ? "—" : section.workerIds.join(", ")}`,
  ];
  if (section.storageTable !== null) {
    footerParts.push(`таблица: ${section.storageTable}`);
  }
  if (inactive) {
    footerParts.push("воркер выключен — раздел открывается в fallback-режиме");
  }

  return (
    <BentoCard
      title={section.label}
      subtitle={section.href}
      href={section.href}
      state={visualState}
      testId={`channel-card-${section.id}`}
      revealIndex={revealIndex}
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
