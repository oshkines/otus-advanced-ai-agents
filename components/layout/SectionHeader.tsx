import type { ReactElement } from "react";

import { StatusBadge } from "@/components/layout/StatusBadge";
import { Topbar } from "@/components/layout/Topbar";
import { PartialBanner } from "@/components/states/PartialBanner";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface SectionHeaderProps {
  readonly section: DashboardNavSection | null;
  readonly title: string;
  readonly description: string;
  readonly generatedAtIso: string;
}

/** Заголовок страницы-канала: название, описание, статус и метка актуальности данных. */
export function SectionHeader({
  section,
  title,
  description,
  generatedAtIso,
}: SectionHeaderProps): ReactElement {
  const status = section?.status ?? "not_connected";

  return (
    <div className="space-y-3">
      <Topbar
        title={title}
        subtitle={description}
        trailing={<StatusBadge status={status} />}
      />
      <PartialBanner
        generatedAtIso={generatedAtIso}
        note="воркер канала ещё не реализован, источник — SQLite после Phase 6"
      />
    </div>
  );
}

