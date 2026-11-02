"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { cn } from "@/lib/cn";

export type OptimisticState = "idle" | "pending" | "success" | "error";

export const DEFAULT_OFFLINE_MESSAGE =
  "Нет сети: запрос не отправлен. Повторите, когда соединение восстановится.";

/** Шаг между строками прогресса: достаточно, чтобы шаги читались, но не тормозили UX. */
const STEP_INTERVAL_MS = 260;

export interface UseOptimisticStepsResult {
  readonly state: OptimisticState;
  readonly visibleSteps: readonly string[];
  readonly message: string | null;
  readonly run: () => void;
  readonly reset: () => void;
}

/**
 * Машина состояний оптимистичного действия (design.md §7, PRD_CHALLENGE.md US-EM-03/US-RZ-04).
 *
 * - `idle → pending` — сразу при запуске, кнопки блокируются;
 * - шаги проявляются последовательно (`visibleSteps`), без page-level спиннера;
 * - `pending → success` — по завершении таймеров;
 * - `pending → error` — при `offline` (сразу или во время выполнения);
 * - таймеры очищаются при размонтировании, утечек нет.
 */
export function useOptimisticSteps(
  steps: readonly string[],
  successMessage: string,
  offlineMessage: string = DEFAULT_OFFLINE_MESSAGE,
): UseOptimisticStepsResult {
  const [state, setState] = useState<OptimisticState>("idle");
  const [stepCount, setStepCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback((): void => {
    for (const timerId of timersRef.current) {
      window.clearTimeout(timerId);
    }
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const run = useCallback((): void => {
    clearTimers();
    setMessage(null);

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState("error");
      setStepCount(0);
      setMessage(offlineMessage);
      return;
    }

    setState("pending");
    setStepCount(0);

    steps.forEach((_step, index) => {
      const timerId = window.setTimeout(() => {
        setStepCount(index + 1);
      }, STEP_INTERVAL_MS * (index + 1));
      timersRef.current.push(timerId);
    });

    const doneId = window.setTimeout(() => {
      setState("success");
      setMessage(successMessage);
    }, STEP_INTERVAL_MS * (steps.length + 1));
    timersRef.current.push(doneId);
  }, [clearTimers, offlineMessage, steps, successMessage]);

  const reset = useCallback((): void => {
    clearTimers();
    setState("idle");
    setStepCount(0);
    setMessage(null);
  }, [clearTimers]);

  // Обрыв сети во время выполнения не должен оставлять пользователя в вечном `pending`.
  useEffect(() => {
    if (state !== "pending") {
      return;
    }

    const handleOffline = (): void => {
      clearTimers();
      setState("error");
      setStepCount(0);
      setMessage(offlineMessage);
    };

    window.addEventListener("offline", handleOffline);
    return () => window.removeEventListener("offline", handleOffline);
  }, [state, offlineMessage, clearTimers]);

  return {
    state,
    visibleSteps: steps.slice(0, stepCount),
    message,
    run,
    reset,
  };
}

export type ActionTone = "primary" | "success";

const TONE_CLASS: Readonly<Record<ActionTone, string>> = {
  primary:
    "border-primary/50 bg-primary/10 text-primary hover:border-primary hover:bg-primary/20",
  success:
    "border-success/60 bg-success/20 text-success-soft hover:border-success-soft hover:bg-success/30",
};

export interface OptimisticActionProps {
  readonly label: string;
  readonly steps: readonly string[];
  readonly successMessage: string;
  readonly testId: string;
  readonly ariaLabel?: string;
  readonly tone?: ActionTone;
  readonly disabled?: boolean;
  readonly offlineMessage?: string;
  readonly className?: string;
}

/**
 * Кнопка оптимистичного действия (Vercel-паттерн: шаги вместо спиннера).
 * Все состояния помечены `data-state` для e2e и визуальной проверки.
 */
export function OptimisticAction({
  label,
  steps,
  successMessage,
  testId,
  ariaLabel,
  tone = "primary",
  disabled = false,
  offlineMessage,
  className,
}: OptimisticActionProps): ReactElement {
  const { state, visibleSteps, message, run } = useOptimisticSteps(
    steps,
    successMessage,
    offlineMessage,
  );
  const isPending = state === "pending";
  const buttonLabel = isPending ? "Выполняю…" : state === "error" ? "Повторить" : label;

  return (
    <div
      data-testid={testId}
      data-state={state}
      className={cn("flex min-w-0 flex-col items-start gap-1.5", className)}
    >
      <button
        type="button"
        onClick={run}
        disabled={disabled || isPending}
        aria-busy={isPending}
        aria-label={ariaLabel ?? label}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-[11px] font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          "disabled:cursor-progress disabled:opacity-60",
          TONE_CLASS[tone],
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full bg-current", isPending && "animate-pulse")}
        />
        {buttonLabel}
      </button>

      {isPending && visibleSteps.length > 0 ? (
        <ol
          aria-live="polite"
          data-testid={`${testId}-steps`}
          className="space-y-0.5 font-mono text-[10px] leading-4 text-muted"
        >
          {visibleSteps.map((step) => (
            <li key={step} className="truncate">
              ▸ {step}
            </li>
          ))}
        </ol>
      ) : null}

      {state === "success" && message !== null ? (
        <p
          role="status"
          data-testid={`${testId}-status`}
          className="text-[10px] leading-4 text-success-soft"
        >
          {message}
        </p>
      ) : null}

      {state === "error" && message !== null ? (
        <p role="alert" data-testid={`${testId}-error`} className="text-[10px] leading-4 text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}

