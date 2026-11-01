/**
 * Типы контракта «config/orchestrator.json ↔ UI».
 * Спецификация: .planning/phases/phase-05-bento-dashboard/CONTRACT.md
 */

export type IconName = "mail" | "briefcase" | "train" | "grid" | "rocket";

export interface CoreConfig {
  readonly name: string;
  readonly runtime: string;
  readonly target_platform: string | null;
  readonly log_level: string | null;
  readonly timezone: string | null;
  readonly tick_interval_sec: number;
}

export interface WorkerConfig {
  readonly id: string;
  readonly script: string;
  readonly interpreter: string;
  readonly enabled: boolean;
  readonly schedule: string | null;
  readonly timeout_sec: number;
  readonly stdout_format: string;
  readonly env_required: readonly string[];
  readonly args: readonly string[];
}

export interface StorageSqliteConfig {
  readonly path: string;
  readonly dedup_window_days: number;
  readonly tables: readonly string[];
}

export interface NavItemConfig {
  readonly id: string;
  readonly label_key: string;
  readonly icon: string;
  readonly order: number;
  readonly worker_ids: readonly string[];
  readonly storage_table: string | null;
}

export interface DashboardUiConfig {
  readonly framework: string;
  readonly app_dir: string;
  readonly refresh_interval_sec: number;
  readonly navigation: readonly NavItemConfig[];
}

export interface UiConfig {
  readonly status_panel: string;
  readonly auto_open: boolean;
  readonly dashboard: DashboardUiConfig | null;
}

export interface E2EConfig {
  readonly runner: string;
  readonly test_script: string;
  readonly screenshot: string;
}

export interface OrchestratorConfig {
  readonly version: string;
  readonly core: CoreConfig;
  readonly workers: readonly WorkerConfig[];
  readonly storage: { readonly sqlite: StorageSqliteConfig };
  readonly ui: UiConfig;
  readonly e2e: E2EConfig | null;
}

export type SectionStatus = "active" | "disabled" | "not_connected";

export interface DashboardNavSection {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly href: string;
  readonly workerIds: readonly string[];
  readonly storageTable: string | null;
  readonly workers: readonly WorkerConfig[];
  readonly status: SectionStatus;
}

export type WorkerRuntimeStatus = "running" | "idle" | "error" | "unknown";

export interface WorkerStatus {
  readonly workerId: string;
  readonly status: WorkerRuntimeStatus;
  readonly lastRunIso: string | null;
  readonly detail: string | null;
}

export type SourceId = "file-config" | "http-api";

/**
 * Единая модель для UI. Совпадает с ответом будущего BFF-эндпоинта
 * (`/api/dashboard`), поэтому ветка B не меняет компоненты.
 */
export interface DashboardSnapshot {
  readonly sourceId: SourceId;
  readonly generatedAtIso: string;
  readonly configPath: string | null;
  readonly config: OrchestratorConfig | null;
  readonly nav: readonly DashboardNavSection[];
  readonly statuses: Readonly<Record<string, WorkerStatus>>;
  readonly error: string | null;
}
