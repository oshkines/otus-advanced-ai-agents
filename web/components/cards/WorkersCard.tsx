import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { cn } from "@/lib/cn";
import { describeRuntimeStatus } from "@/lib/orchestrator/status";
import type { WorkerConfig, WorkerStatus } from "@/lib/orchestrator/types";

export interface WorkersCardProps {
  readonly workers: readonly WorkerConfig[];
  readonly statuses: Readonly<Record<string, WorkerStatus>>;
}

/** Список воркеров из секции `workers` конфига + их рантайм-состояние. */
export function WorkersCard({ workers, statuses }: WorkersCardProps): ReactElement {
  return (
    <BentoCard
      testId="workers-card"
      title="Python Workers"
      subtitle={`${workers.length} в конфиге`}
      className="col-span-12 md:col-span-6 lg:col-span-3 lg:row-span-2"
      footer="JSON в stdout · таймауты из config"
    >
      {workers.length === 0 ? (
        <p className="text-sm text-muted">Воркеры не описаны в конфиге.</p>
      ) : (
        <ul className="space-y-2">
          {workers.map((worker) => {
            const runtime = statuses[worker.id];
            return (
              <li
                key={worker.id}
                className="rounded-xl border border-line/70 bg-canvas/40 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-ink">{worker.id}</span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-semibold",
                      worker.enabled ? "text-ok" : "text-idle",
                    )}
                  >
                    {worker.enabled ? "enabled" : "off"}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted">
                  {worker.schedule ?? "manual"} · {worker.timeout_sec}s ·{" "}
                  {describeRuntimeStatus(runtime?.status ?? "unknown")}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </BentoCard>
  );
}
