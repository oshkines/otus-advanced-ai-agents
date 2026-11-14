"use client";

import Link from "next/link";
import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Кривая design.md §8. */
const EASE_STANDARD: [number, number, number, number] = [0.4, 0, 0.2, 1];

const MotionLink = motion.create(Link);

export type CtaTone = "primary" | "ghost";

export interface OverviewCtaProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly tone?: CtaTone;
  readonly testId?: string;
  readonly className?: string;
}

const TONE_CLASS: Readonly<Record<CtaTone, string>> = {
  primary:
    "border-primary bg-primary text-canvas hover:border-primary-hover hover:bg-primary-hover",
  ghost:
    "border-border bg-canvas text-ink hover:border-primary/50 hover:bg-surface",
};

/**
 * CTA публичной страницы: ссылка с мягким hover/tap-откликом.
 *
 * Высота 40 px — соответствие закону Фиттса (design.md §5). Скругление — токен
 * `rounded-control` (8 px): Bento-карточки остаются строгими (12 px), а
 * интерактив выглядит современнее. `MotionConfig reducedMotion="user"` в
 * корневом layout отключает transform для пользователей с reduced-motion.
 */
export function OverviewCta({
  href,
  children,
  tone = "primary",
  testId,
  className,
}: OverviewCtaProps): ReactElement {
  return (
    <MotionLink
      href={href}
      data-testid={testId}
      whileHover={{ y: -1, transition: { duration: 0.16, ease: EASE_STANDARD } }}
      whileTap={{ scale: 0.98, transition: { duration: 0.12, ease: EASE_STANDARD } }}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-sm font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </MotionLink>
  );
}
