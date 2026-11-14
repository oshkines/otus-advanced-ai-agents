import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { Metric } from "@/components/bento/Metric";
import type { OrchestratorConfig } from "@/lib/orchestrator/types";

export interface StorageCardProps {
  readonly config: OrchestratorConfig;
}

/** SQLite-кэш дедупликации: путь, окно дедупликации и таблицы из конфига. */
export function StorageCard({ config }: StorageCardProps): ReactElement {
  const sqlite = config.storage.sqlite;

  return (
    <BentoCard
      testId="storage-card"
      title="SQLite3 Cache"
      subtitle="дедупликация сообщений и писем"
      className="col-span-12 lg:col-span-6"
      footer="Источник статусов каналов в будущем (Phase 6)"
    >
      <Metric label="Файл БД" value={sqlite.path} mono />
      <Metric label="Окно дедупликации" value={`${sqlite.dedup_window_days} дней`} mono />
      <Metric
        label="Таблицы"
        value={sqlite.tables.length === 0 ? "—" : sqlite.tables.join(", ")}
        mono
      />
    </BentoCard>
  );
}
