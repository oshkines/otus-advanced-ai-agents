import type { ReactElement } from "react";

import { ReloadButton } from "@/components/states/ReloadButton";

export interface ConfigErrorProps {
  readonly error: string;
  readonly configPath: string | null;
}

/**
 * Состояние L2 (см. docs/handoff/PRD_CHALLENGE.md §7.2): конфиг не прочитан.
 *
 * Ошибка не прячется и не заменяется на «что-то пошло не так»: показана причина,
 * путь к файлу и следующий шаг. Навигация при этом остаётся рабочей.
 */
export function ConfigError({ error, configPath }: ConfigErrorProps): ReactElement {
  return (
    <section
      role="alert"
      data-testid="config-error-banner"
      className="m-4 rounded-bento border border-danger/60 bg-danger/10 px-4 py-3 lg:m-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-danger">Конфиг orchestrator.json не прочитан</p>
          <p className="mt-1 text-xs text-muted">
            Навигация и страницы каналов остаются доступны: меню строится из резервной навигации,
            данные каналов помечены как MOCK.
          </p>
        </div>
        <ReloadButton />
      </div>

      <dl className="mt-3 grid gap-1 text-xs">
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="text-muted">Причина:</dt>
          <dd className="min-w-0 break-all font-mono text-danger">{error}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="text-muted">Путь:</dt>
          <dd className="min-w-0 break-all font-mono text-ink">{configPath ?? "config: not found"}</dd>
        </div>
      </dl>

      <p className="mt-2 text-xs text-muted">
        Подсказка: запускайте Next.js из каталога web/ или задайте переменную окружения
        ORCHESTRATOR_CONFIG_PATH.
      </p>
    </section>
  );
}
