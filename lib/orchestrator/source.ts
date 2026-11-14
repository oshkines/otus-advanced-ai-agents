import { loadOrchestratorConfig } from "./config";
import { deriveNavigation } from "./derive";
import { getStatusProvider } from "./status";
import type { DashboardSnapshot, SourceId, WorkerStatus } from "./types";

/**
 * Источник данных дашборда.
 *
 * Вариант A (текущий): `fileConfigSource` — Server Component читает `config/orchestrator.json`.
 * Вариант B (заложено): `httpDashboardSource` — `fetch("/api/dashboard")` + polling на клиенте.
 * Компоненты bento и страницы от выбора источника не зависят (см. CONTRACT.md, раздел 6.1).
 */
export interface DashboardSource {
  readonly id: SourceId;
  load(): Promise<DashboardSnapshot>;
}

function emptySnapshot(
  sourceId: SourceId,
  configPath: string | null,
  error: string,
): DashboardSnapshot {
  return {
    sourceId,
    generatedAtIso: new Date().toISOString(),
    configPath,
    config: null,
    nav: [],
    statuses: {},
    error,
  };
}

export const fileConfigSource: DashboardSource = {
  id: "file-config",
  async load(): Promise<DashboardSnapshot> {
    const result = await loadOrchestratorConfig();
    if (!result.ok) {
      return emptySnapshot("file-config", result.configPath, result.error);
    }

    const nav = deriveNavigation(result.config);
    const statuses: Readonly<Record<string, WorkerStatus>> = await getStatusProvider().readStatuses(
      result.config.workers.map((worker) => worker.id),
    );

    return {
      sourceId: "file-config",
      generatedAtIso: new Date().toISOString(),
      configPath: result.configPath,
      config: result.config,
      nav,
      statuses,
      error: null,
    };
  },
};

export function getDashboardSource(): DashboardSource {
  // Ветка B: при DASHBOARD_SOURCE=http-api вернуть httpDashboardSource.
  return fileConfigSource;
}
