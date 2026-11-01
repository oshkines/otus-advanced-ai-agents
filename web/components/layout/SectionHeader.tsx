import type { ReactElement } from "react";

import { StatusBadge } from "@/components/layout/StatusBadge";
import { Topbar } from "@/components/layout/Topbar";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface SectionHeaderProps {
  readonly section: DashboardNavSection | null;
  readonly title: string;
  readonly description: string;
}

/** Заголовок страницы-канала: название, описание, статус и пометка о данных-заглушках. */
export function SectionHeader({ section, title, description }: SectionHeaderProps): ReactElement {
  const status = section?.status ?? "not_connected";

  return (
    <div className="space-y-3">
      <Topbar
        title={title}
        subtitle={description}
        trailing={<StatusBadge status={status} />}
      />
      <p className="inline-flex items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-[11px] text-warn">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
        MOCK-данные: воркер канала ещё не реализован, источник — SQLite после Phase 6
      </p>
    </div>
  );
}
