import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface BentoGridProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Корневая bento-сетка: 12 колонок, авто-строки, mobile-first. */
export function BentoGrid({ children, className }: BentoGridProps): ReactElement {
  return (
    <div
      data-testid="bento-grid"
      className={cn(
        "mt-4 grid grid-cols-12 auto-rows-[minmax(7.5rem,auto)] gap-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
