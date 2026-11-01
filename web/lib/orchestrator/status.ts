import type { WorkerRuntimeStatus, WorkerStatus } from "./types";

/**
 * Провайдер рантайм-статусов воркеров.
 *
 * Точка расширения (см. CONTRACT.md, раздел 6.2): реальные статусы появятся из SQLite
 * (`storage.sqlite.path` → data/cache.db) через серверный провайдер. Вызывать только
 * из Server Component / Route Handler, никогда из браузера.
 */
export interface StatusProvider {
  readonly id: string;
  readStatuses(workerIds: readonly string[]): Promise<Readonly<Record<string, WorkerStatus>>>;
}

export const nullStatusProvider: StatusProvider = {
  id: "null",
  async readStatuses(workerIds: readonly string[]): Promise<Readonly<Record<string, WorkerStatus>>> {
    const result: Record<string, WorkerStatus> = {};
    for (const workerId of workerIds) {
      result[workerId] = {
        workerId,
        status: "unknown",
        lastRunIso: null,
        detail: null,
      };
    }
    return result;
  },
};

export function getStatusProvider(): StatusProvider {
  // Ветка B: вернуть sqliteStatusProvider/httpStatusProvider в зависимости от окружения.
  return nullStatusProvider;
}

export function isRunning(status: WorkerStatus | undefined): boolean {
  return status?.status === "running";
}

export function describeRuntimeStatus(status: WorkerRuntimeStatus): string {
  switch (status) {
    case "running":
      return "выполняется";
    case "idle":
      return "ожидание";
    case "error":
      return "ошибка";
    case "unknown":
    default:
      return "нет данных";
  }
}
