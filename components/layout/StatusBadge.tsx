import { cn } from "@/lib/cn";
import type { SectionStatus } from "@/lib/orchestrator/types";

interface Tone {
  readonly dot: string;
  readonly text: string;
  readonly label: string;
}

const TONES: Readonly<Record<SectionStatus, Tone>> = {
  active: { dot: "bg-ok", text: "text-ok", label: "активен" },
  disabled: { dot: "bg-idle", text: "text-idle", label: "выключен" },
  not_connected: { dot: "bg-warn", text: "text-warn", label: "не подключён" },
};

export interface StatusBadgeProps {
  readonly status: SectionStatus;
  readonly label?: string;
  readonly testId?: string;
  readonly className?: string;
}

/** Индикатор состояния канала: цвет + текстовое значение (a11y, не только цвет). */
export function StatusBadge({
  status,
  label,
  testId = "status-badge",
  className,
}: StatusBadgeProps) {
  const tone = TONES[status];
  return (
    <span
      role="status"
      data-testid={testId}
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-line bg-canvas/60 px-3 py-1 text-xs font-semibold",
        tone.text,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", tone.dot)} />
      {label ?? tone.label}
    </span>
  );
}
