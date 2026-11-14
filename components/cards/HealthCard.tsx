import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { Metric } from "@/components/bento/Metric";
import { StatusBadge } from "@/components/layout/StatusBadge";
import {
  countEnabledWorkers,
  countNotConnectedSections,
  deriveOverallStatus,
} from "@/lib/orchestrator/derive";
import type { DashboardNavSection, OrchestratorConfig } from "@/lib/orchestrator/types";

export interface HealthCardProps {
  readonly config: OrchestratorConfig;
  readonly sections: readonly DashboardNavSection[];
}

/** Сводное состояние системы: включённые воркеры + неподключённые каналы. */
export function HealthCard({ config, sections }: HealthCardProps): ReactElement {
  const enabledWorkers = countEnabledWorkers(config);
  const totalWorkers = config.workers.length;
  const notConnected = countNotConnectedSections(sections);
  const overall = deriveOverallStatus(sections);

  return (
    <BentoCard
      testId="health-card"
      title="Health"
      subtitle="агрегат по workers и каналам"
      className="col-span-12 md:col-span-6 lg:col-span-3"
      footer={<StatusBadge status={overall} />}
    >
      <p className="text-3xl font-semibold tracking-tight">
        {enabledWorkers}
        <span className="text-base text-muted"> / {totalWorkers}</span>
      </p>
      <p className="mt-1 text-xs text-muted">воркеров включено</p>
      <div className="mt-3">
        <Metric
          label="Каналов всего"
          value={String(sections.length)}
          mono
        />
        <Metric
          label="Не подключено"
          value={String(notConnected)}
          mono
          tone={notConnected > 0 ? "warn" : "ok"}
        />
      </div>
    </BentoCard>
  );
}
