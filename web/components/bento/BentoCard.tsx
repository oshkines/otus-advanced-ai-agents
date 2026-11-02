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
  /**
   * Заблокированная карточка канала: ссылка не рендерится (клик и Tab недоступны),
   * поверхность и текст уходят в приглушённый серый.
   */
  readonly inactive?: boolean;
  /** Визуальное состояние для e2e-селекторов: `active` | `not_connected`. */
  readonly state?: string;
}

/**
 * Базовая bento-карточка. Если передан `href` — превращается в ссылку
 * (клик по карточке канала ведёт в раздел, п.4.1 DISCUSS.md).
 *
 * `inactive` — состояние «канал не подключён»: вместо `<Link>` рендерится
 * `<section aria-disabled="true">`, поэтому переход по клику и Tab невозможен,
 * hover-подсветка и стрелка «→» убраны, поверхность приглушена. Текст остаётся
 * на `--color-muted` (5.7:1 на `--color-surface`), чтобы ослабление не роняло
 * контраст ниже AA.
 */
export function BentoCard({
  title,
  subtitle,
  children,
  footer,
  href,
  testId,
  className,
  inactive = false,
  state,
}: BentoCardProps): ReactElement {
  /* У неактивной карточки цель перехода обнуляется — дальше идёт ветка <section>. */
  const targetHref = inactive ? undefined : href;

  const classes = cn(
    "flex h-full flex-col rounded-bento border p-4 shadow-sm",
    inactive
      ? "cursor-not-allowed border-border/60 bg-surface/70"
      : "border-border bg-surface",
    targetHref === undefined
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
        {targetHref === undefined ? null : (
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

  if (targetHref === undefined) {
    return (
      <section
        data-testid={testId}
        data-card-state={state}
        data-inactive={inactive ? "true" : undefined}
        aria-disabled={inactive ? true : undefined}
        title={inactive && href !== undefined ? "Канал не подключён: переход заблокирован" : undefined}
        className={classes}
      >
        {content}
      </section>
    );
  }

  return (
    <Link href={targetHref} data-testid={testId} data-card-state={state} className={classes}>
      {content}
    </Link>
  );
}
