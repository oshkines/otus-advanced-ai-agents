import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseOrchestratorConfig } from "./schema";
import type { OrchestratorConfig } from "./types";

/** Переменная окружения для override пути к конфигу (нужна из-за пробелов/кириллицы в пути). */
export const CONFIG_PATH_ENV = "ORCHESTRATOR_CONFIG_PATH";

/** По умолчанию конфиг лежит на уровень выше `web/` — в корне проекта. */
const DEFAULT_CONFIG_RELATIVE: string = path.join("..", "config", "orchestrator.json");

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: OrchestratorConfig; readonly configPath: string }
  | { readonly ok: false; readonly error: string; readonly configPath: string };

let cachedConfig: Promise<ConfigLoadResult> | null = null;

/**
 * Абсолютный путь к конфигу: сначала `ORCHESTRATOR_CONFIG_PATH`, затем `../config/orchestrator.json`
 * относительно рабочего каталога процесса (`web/` при `next dev` / `next start`).
 */
export function resolveConfigPath(cwd: string = process.cwd()): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.resolve(cwd, DEFAULT_CONFIG_RELATIVE);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function readConfig(configPath: string): Promise<ConfigLoadResult> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return { ok: true, config: parseOrchestratorConfig(parsed), configPath };
  } catch (error: unknown) {
    const reason = describeError(error);
    const hint =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? ` (задайте ${CONFIG_PATH_ENV} или запускайте Next.js из каталога web/)`
        : "";
    return { ok: false, configPath, error: `${reason}${hint}` };
  }
}

/**
 * Читает и валидирует конфиг один раз за жизнь процесса (в dev-режиме кэш сбрасывается
 * перезапуском/пересборкой модуля).
 */
export function loadOrchestratorConfig(): Promise<ConfigLoadResult> {
  if (cachedConfig === null) {
    cachedConfig = readConfig(resolveConfigPath());
  }
  return cachedConfig;
}

/** Сброс кэша — используется тестами и будущим BFF-эндпоинтом (вариант B). */
export function resetConfigCache(): void {
  cachedConfig = null;
}
