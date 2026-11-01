import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  readonly title: string;
  readonly hint: string;
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * Состояние Empty из design.md §6: система в режиме ожидания.
 * Занимает всю ширину bento-сетки, поэтому рендерится внутри `BentoGrid`.
 */
export function EmptyState({
  title,
  hint,
  children,
  testId = "empty-state",
  className,
}: EmptyStateProps): ReactElement {
  return (
    <section
      data-testid={testId}
      className={cn(
        "col-span-12 flex flex-col items-center justify-center rounded-bento border border-dashed border-border bg-surface/60 px-6 py-10 text-center",
        className,
      )}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-idle" />
      <p className="mt-3 text-sm leading-5 text-ink">{title}</p>
      <p className="mt-1 max-w-prose text-xs leading-4 text-muted">{hint}</p>
      {children}
    </section>
  );
}
