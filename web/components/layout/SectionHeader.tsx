import type { ReactElement, ReactNode } from "react";

import { StatusBadge } from "@/components/layout/StatusBadge";
import { Topbar } from "@/components/layout/Topbar";
import { PartialBanner } from "@/components/states/PartialBanner";
import type { DashboardNavSection } from "@/lib/orchestrator/types";

export interface SectionHeaderProps {
  readonly section: DashboardNavSection | null;
  readonly title: string;
  readonly description: string;
  readonly generatedAtIso: string;
  /**
   * Свой баннер источника данных (например, `ApiStatusBadge`: API online /
   * `API offline / fallback`). Без него показывается MOCK-баннер partial-состояния.
   */
  readonly banner?: ReactNode;
}

/** Заголовок страницы-канала: название, описание, статус и метка актуальности данных. */
export function SectionHeader({
  section,
  title,
  description,
  generatedAtIso,
  banner,
}: SectionHeaderProps): ReactElement {
  const status = section?.status ?? "not_connected";

  return (
    <div className="space-y-3">
      <Topbar
        title={title}
        subtitle={description}
        trailing={<StatusBadge status={status} />}
      />
      {banner === undefined ? (
        <PartialBanner
          generatedAtIso={generatedAtIso}
          note="источник — PostgreSQL через FastAPI, при недоступности API показывается fallback"
        />
      ) : (
        banner
      )}
    </div>
  );
}

