import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface BentoCardProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly href?: string;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * Базовая bento-карточка. Если передан `href` — превращается в ссылку
 * (клик по карточке канала ведёт в раздел, п.4.1 DISCUSS.md).
 */
export function BentoCard({
  title,
  subtitle,
  children,
  footer,
  href,
  testId,
  className,
}: BentoCardProps): ReactElement {
  const classes = cn(
    "flex h-full flex-col rounded-bento border border-border bg-surface p-4 shadow-sm",
    href === undefined
      ? null
      : "transition-colors hover:border-primary/50 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
    className,
  );

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            {title}
          </h2>
          {subtitle === undefined ? null : (
            <p className="mt-1 truncate text-xs text-muted/80">{subtitle}</p>
          )}
        </div>
        {href === undefined ? null : (
          <span aria-hidden="true" className="text-xs text-muted">
            →
          </span>
        )}
      </div>
      <div className="mt-3 flex-1 text-sm">{children}</div>
      {footer === undefined ? null : (
        <div className="mt-3 border-t border-line/70 pt-2 text-[11px] text-muted">{footer}</div>
      )}
    </>
  );

  if (href === undefined) {
    return (
      <section data-testid={testId} className={classes}>
        {content}
      </section>
    );
  }

  return (
    <Link href={href} data-testid={testId} className={classes}>
      {content}
    </Link>
  );
}
