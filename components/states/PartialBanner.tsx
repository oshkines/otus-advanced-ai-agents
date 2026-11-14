import type { ReactElement } from "react";

import { formatTimestamp } from "@/lib/format";

export interface PartialBannerProps {
  readonly generatedAtIso: string;
  readonly note?: string;
}

/**
 * Состояние Partial (PRD_CHALLENGE.md §7.4): показаны последние доступные данные.
 *
 * Пока воркеры каналов не реализованы (Phase 6), источником служат MOCK-данные,
 * поэтому бейдж одновременно фиксирует «это не боевые данные» и время снимка.
 */
export function PartialBanner({ generatedAtIso, note }: PartialBannerProps): ReactElement {
  return (
    <p
      role="status"
      data-testid="partial-banner"
      className="inline-flex flex-wrap items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-[11px] leading-4 text-warning"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span>
        MOCK · данные последнего успешного запуска:{" "}
        <span className="font-mono">{formatTimestamp(generatedAtIso)}</span>
      </span>
      {note === undefined ? null : <span className="text-warning">· {note}</span>}
    </p>
  );
}
