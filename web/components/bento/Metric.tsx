import type { ReactElement } from "react";

import { cn } from "@/lib/cn";

export type MetricTone = "ink" | "muted" | "ok" | "warn" | "danger" | "idle";

const TONE_CLASS: Readonly<Record<MetricTone, string>> = {
  ink: "text-ink",
  muted: "text-muted",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  idle: "text-idle",
};

export interface MetricProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: MetricTone;
  readonly mono?: boolean;
}

/** Строка «label — value» внутри bento-карточки. */
export function Metric({ label, value, tone = "ink", mono = false }: MetricProps): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-line/70 py-1.5 last:border-b-0">
      <span className="text-xs text-muted">{label}</span>
      <span
        className={cn(
          "max-w-[65%] break-words text-right text-sm",
          mono ? "font-mono" : null,
          TONE_CLASS[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}
