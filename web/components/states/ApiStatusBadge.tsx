import type { ReactElement } from "react";

import { cn } from "@/lib/cn";

export interface ApiStatusBadgeProps {
  readonly online: boolean;
  readonly detail?: string;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * Статус живого API на странице (требование graceful fallback).
 *
 * `online = false` означает, что FastAPI не ответил и страница показывает
 * MOCK/последние данные — текст ровно такой, как ожидает приёмка:
 * `API offline / fallback`.
 */
export function ApiStatusBadge({
  online,
  detail,
  testId = "api-status",
  className,
}: ApiStatusBadgeProps): ReactElement {
  return (
    <span
      role="status"
      data-testid={testId}
      data-state={online ? "online" : "offline"}
      className={cn(
        "inline-flex flex-wrap items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold leading-4",
        online ? "border-ok/50 bg-ok/10 text-ok" : "border-warn/50 bg-warn/10 text-warn",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-warn")}
      />
      <span className="font-mono">{online ? "API online" : "API offline / fallback"}</span>
      {detail === undefined ? null : <span className="font-normal opacity-80">{detail}</span>}
    </span>
  );
}
