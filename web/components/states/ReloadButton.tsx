"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactElement } from "react";

import { cn } from "@/lib/cn";

export interface ReloadButtonProps {
  readonly label?: string;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * Повторное чтение серверных данных без перезагрузки страницы.
 *
 * `router.refresh()` заново выполняет Server Components; кэш конфига сбрасывается
 * при ошибке чтения (см. `lib/orchestrator/config.ts`), поэтому «Повторить»
 * действительно перечитывает файл, а не показывает тот же результат.
 */
export function ReloadButton({
  label = "Повторить",
  testId = "config-retry",
  className,
}: ReloadButtonProps): ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      data-testid={testId}
      aria-busy={isPending}
      disabled={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-control border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors",
        "hover:border-primary hover:bg-primary/20",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        "disabled:cursor-progress disabled:opacity-60",
        className,
      )}
    >
      {isPending ? "Перечитываю…" : label}
    </button>
  );
}
