import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { Metric } from "@/components/bento/Metric";
import { formatTimestamp } from "@/lib/format";
import type { OrchestratorConfig, SourceId } from "@/lib/orchestrator/types";

export interface CoreCardProps {
  readonly config: OrchestratorConfig;
  readonly sourceId: SourceId;
  readonly generatedAtIso: string;
}

/** Hero-карточка обзора: параметры C++20 ядра из секции `core`. */
export function CoreCard({ config, sourceId, generatedAtIso }: CoreCardProps): ReactElement {
  const { core } = config;

  return (
    <BentoCard
      testId="core-card"
      title="C++20 Core"
      subtitle={core.runtime}
      className="col-span-12 lg:col-span-6 lg:row-span-2"
      footer={`Снимок: ${formatTimestamp(generatedAtIso)} · источник: ${sourceId}`}
    >
      <p className="text-xl font-semibold tracking-tight lg:text-2xl">{core.name}</p>
      <p className="mt-1 text-sm text-muted">
        {core.target_platform ?? "target_platform: —"}
      </p>
      <div className="mt-3">
        <Metric label="Tick" value={`${core.tick_interval_sec} s`} mono />
        <Metric label="Часовой пояс" value={core.timezone ?? "—"} mono />
        <Metric label="Log level" value={core.log_level ?? "—"} mono />
        <Metric label="Версия конфига" value={`v${config.version}`} mono />
        <Metric label="Источник данных" value={sourceId} mono />
      </div>
    </BentoCard>
  );
}
