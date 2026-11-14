"use client";

import Link from "next/link";
import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Reveal (design.md §8): сдвиг 14 px вверх и 420 ms по кривой
 * cubic-bezier(0.4, 0, 0.2, 1). Ограничение по задержке держит «лесенку»
 * карточек в пределах 240 ms, чтобы сетка не появлялась дольше полусекунды.
 */
const REVEAL_DISTANCE_PX = 14;
const REVEAL_DURATION_SEC = 0.42;
const REVEAL_STAGGER_SEC = 0.04;
const REVEAL_MAX_DELAY_SEC = 0.24;
const HOVER_LIFT_PX = -2;

/** Кривая design.md §8 в виде, который ожидает Motion. */
const EASE_STANDARD: [number, number, number, number] = [0.4, 0, 0.2, 1];

/** `Link` с поддержкой motion-пропсов (hover/tap-отклик активной карточки). */
const MotionLink = motion.create(Link);

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
   * поверхность и текст уходят в приглушённый серый, hover/tap-отклик отключён.
   */
  readonly inactive?: boolean;
  /** Визуальное состояние для e2e-селекторов: `active` | `not_connected`. */
  readonly state?: string;
  /** Порядковый номер в сетке: задаёт задержку появления (0, 40, 80 … ms). */
  readonly revealIndex?: number;
}

/**
 * Базовая bento-карточка. Если передан `href` — превращается в ссылку
 * (клик по карточке канала ведёт в раздел, п.4.1 DISCUSS.md).
 *
 * `inactive` — состояние «канал не подключён»: вместо `<Link>` рендерится
 * `<section aria-disabled="true">`, поэтому переход по клику и Tab невозможен,
 * hover-подсветка и стрелка «→» убраны, поверхность приглушена, а motion-отклик
 * на наведение/нажатие не применяется вовсе. Текст остаётся на `--color-muted`
 * (5.7:1 на `--color-surface`), чтобы ослабление не роняло контраст ниже AA.
 *
 * Геометрия карточки строгая (`rounded-bento` = 12 px), скругление интерактива
 * внутри — `rounded-bento-inner` (8 px): Bento-сетка не «плывёт».
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
  revealIndex = 0,
}: BentoCardProps): ReactElement {
  /* У неактивной карточки цель перехода обнуляется — дальше идёт ветка <section>. */
  const targetHref = inactive ? undefined : href;
  const delay = Math.min(revealIndex * REVEAL_STAGGER_SEC, REVEAL_MAX_DELAY_SEC);

  /*
   * Неактивная карточка приглушена, но её поверхность остаётся НЕПРОЗРАЧНОЙ:
   * фон Aurora (включая корабль-пасхалку) лежит на `z-index: -1`, и полупрозрачная
   * заливка позволила бы силуэту «просвечивать» сквозь текст РЖД/Вакансий.
   * Приглушение читается по border/text/отсутствию hover-отклика, контраст
   * `--color-muted` на `--color-surface` остаётся 5.7:1 (AA).
   */
  const classes = cn(
    "flex h-full flex-col rounded-bento border p-4 shadow-sm",
    inactive ? "cursor-not-allowed border-border/60 bg-surface" : "border-border bg-surface",
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
      <motion.section
        data-testid={testId}
        data-card-state={state}
        data-inactive={inactive ? "true" : undefined}
        aria-disabled={inactive ? true : undefined}
        title={inactive && href !== undefined ? "Канал не подключён: переход заблокирован" : undefined}
        initial={{ opacity: 0, y: REVEAL_DISTANCE_PX }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: REVEAL_DURATION_SEC, ease: EASE_STANDARD, delay }}
        className={classes}
      >
        {content}
      </motion.section>
    );
  }

  return (
    <MotionLink
      href={targetHref}
      data-testid={testId}
      data-card-state={state}
      initial={{ opacity: 0, y: REVEAL_DISTANCE_PX }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{
        y: HOVER_LIFT_PX,
        transition: { duration: 0.18, ease: EASE_STANDARD },
      }}
      whileTap={{ scale: 0.995, transition: { duration: 0.12, ease: EASE_STANDARD } }}
      transition={{ duration: REVEAL_DURATION_SEC, ease: EASE_STANDARD, delay }}
      className={classes}
    >
      {content}
    </MotionLink>
  );
}

