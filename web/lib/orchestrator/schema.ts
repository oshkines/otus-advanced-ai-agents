import type {
  CoreConfig,
  DashboardUiConfig,
  E2EConfig,
  NavItemConfig,
  OrchestratorConfig,
  StorageSqliteConfig,
  UiConfig,
  WorkerConfig,
} from "./types";

/**
 * Ошибка валидации конфига: собирает все проблемы сразу, чтобы баннер в UI
 * показывал список, а не первую попавшуюся.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Некорректный orchestrator.json: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, path: string, issues: string[]): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }
  if (value !== undefined) {
    issues.push(`${path}: ожидался объект`);
  }
  return {};
}

function readString(
  source: JsonObject,
  key: string,
  path: string,
  issues: string[],
  fallback: string,
): string {
  const value = source[key];
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    issues.push(`${path}.${key}: ожидалась строка`);
  }
  return fallback;
}

function readOptionalString(
  source: JsonObject,
  key: string,
  path: string,
  issues: string[],
): string | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  issues.push(`${path}.${key}: ожидалась строка или null`);
  return null;
}

function readNumber(
  source: JsonObject,
  key: string,
  path: string,
  issues: string[],
  fallback: number,
): number {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value !== undefined) {
    issues.push(`${path}.${key}: ожидалось число`);
  }
  return fallback;
}

function readBoolean(
  source: JsonObject,
  key: string,
  path: string,
  issues: string[],
  fallback: boolean,
): boolean {
  const value = source[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value !== undefined) {
    issues.push(`${path}.${key}: ожидался boolean`);
  }
  return fallback;
}

function readStringArray(
  source: JsonObject,
  key: string,
  path: string,
  issues: string[],
): string[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}.${key}: ожидался массив строк`);
    return [];
  }
  const result: string[] = [];
  value.forEach((item: unknown, index: number) => {
    if (typeof item === "string") {
      result.push(item);
    } else {
      issues.push(`${path}.${key}[${index}]: ожидалась строка`);
    }
  });
  return result;
}

function parseCore(value: unknown, issues: string[]): CoreConfig {
  const source = asObject(value, "$.core", issues);
  return {
    name: readString(source, "name", "$.core", issues, "ai-dev-orchestrator-core"),
    runtime: readString(source, "runtime", "$.core", issues, "unknown"),
    target_platform: readOptionalString(source, "target_platform", "$.core", issues),
    log_level: readOptionalString(source, "log_level", "$.core", issues),
    timezone: readOptionalString(source, "timezone", "$.core", issues),
    tick_interval_sec: readNumber(source, "tick_interval_sec", "$.core", issues, 30),
  };
}

function parseWorkers(value: unknown, issues: string[]): WorkerConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("$.workers: ожидался массив");
    return [];
  }
  return value.map((item: unknown, index: number) => {
    const path = `$.workers[${index}]`;
    const source = asObject(item, path, issues);
    const id = readString(source, "id", path, issues, "");
    if (id.length === 0) {
      issues.push(`${path}.id: обязательное поле`);
    }
    return {
      id,
      script: readString(source, "script", path, issues, ""),
      interpreter: readString(source, "interpreter", path, issues, "python"),
      enabled: readBoolean(source, "enabled", path, issues, false),
      schedule: readOptionalString(source, "schedule", path, issues),
      timeout_sec: readNumber(source, "timeout_sec", path, issues, 120),
      stdout_format: readString(source, "stdout_format", path, issues, "json"),
      env_required: readStringArray(source, "env_required", path, issues),
      args: readStringArray(source, "args", path, issues),
    };
  });
}

function parseStorage(value: unknown, issues: string[]): { sqlite: StorageSqliteConfig } {
  const storage = asObject(value, "$.storage", issues);
  const sqlite = asObject(storage["sqlite"], "$.storage.sqlite", issues);
  return {
    sqlite: {
      path: readString(sqlite, "path", "$.storage.sqlite", issues, "data/cache.db"),
      dedup_window_days: readNumber(sqlite, "dedup_window_days", "$.storage.sqlite", issues, 30),
      tables: readStringArray(sqlite, "tables", "$.storage.sqlite", issues),
    },
  };
}

function parseNavigation(value: unknown, path: string, issues: string[]): NavItemConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}: ожидался массив`);
    return [];
  }
  return value.map((item: unknown, index: number) => {
    const itemPath = `${path}[${index}]`;
    const source = asObject(item, itemPath, issues);
    const id = readString(source, "id", itemPath, issues, "");
    if (id.length === 0) {
      issues.push(`${itemPath}.id: обязательное поле`);
    }
    return {
      id,
      label_key: readString(source, "label_key", itemPath, issues, `nav.${id}`),
      icon: readString(source, "icon", itemPath, issues, "grid"),
      order: readNumber(source, "order", itemPath, issues, 100),
      worker_ids: readStringArray(source, "worker_ids", itemPath, issues),
      storage_table: readOptionalString(source, "storage_table", itemPath, issues),
    };
  });
}

function parseUi(value: unknown, issues: string[]): UiConfig {
  const source = asObject(value, "$.ui", issues);
  let dashboard: DashboardUiConfig | null = null;

  const rawDashboard = source["dashboard"];
  if (isJsonObject(rawDashboard)) {
    dashboard = {
      framework: readString(rawDashboard, "framework", "$.ui.dashboard", issues, "nextjs-tailwind4"),
      app_dir: readString(rawDashboard, "app_dir", "$.ui.dashboard", issues, "web"),
      refresh_interval_sec: readNumber(
        rawDashboard,
        "refresh_interval_sec",
        "$.ui.dashboard",
        issues,
        15,
      ),
      navigation: parseNavigation(
        rawDashboard["navigation"],
        "$.ui.dashboard.navigation",
        issues,
      ),
    };
  } else if (rawDashboard !== undefined) {
    issues.push("$.ui.dashboard: ожидался объект");
  }

  return {
    status_panel: readString(source, "status_panel", "$.ui", issues, "src/status_panel.html"),
    auto_open: readBoolean(source, "auto_open", "$.ui", issues, false),
    dashboard,
  };
}

function parseE2E(value: unknown, issues: string[]): E2EConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  const source = asObject(value, "$.e2e", issues);
  return {
    runner: readString(source, "runner", "$.e2e", issues, "python-playwright"),
    test_script: readString(source, "test_script", "$.e2e", issues, "tests/browser_test.py"),
    screenshot: readString(source, "screenshot", "$.e2e", issues, ""),
  };
}

/**
 * Разбирает и валидирует `config/orchestrator.json`.
 *
 * Неизвестные поля игнорируются (forward-compatible), отсутствующие получают значения
 * по умолчанию — дашборд остаётся работоспособным даже на конфиге v0.1.0 без `ui.dashboard`.
 */
export function parseOrchestratorConfig(raw: unknown): OrchestratorConfig {
  const issues: string[] = [];
  const root = asObject(raw, "$", issues);

  const config: OrchestratorConfig = {
    version: readString(root, "version", "$", issues, "0.0.0"),
    core: parseCore(root["core"], issues),
    workers: parseWorkers(root["workers"], issues),
    storage: parseStorage(root["storage"], issues),
    ui: parseUi(root["ui"], issues),
    e2e: parseE2E(root["e2e"], issues),
  };

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
  return config;
}

