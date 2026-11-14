"use client";

import { MotionConfig } from "motion/react";
import type { ReactElement, ReactNode } from "react";

export interface MotionProviderProps {
  readonly children: ReactNode;
}

/**
 * Глобальные настройки Motion для всего приложения (design.md §8).
 *
 * `reducedMotion="user"` — единственная точка, где учитывается системная
 * настройка «уменьшить движение»: transform/layout-анимации отключаются,
 * прозрачность остаётся, поэтому интерфейс не «прыгает» у пользователей с
 * вестибулярными ограничениями (и не греет CPU на Windows 11).
 */
export function MotionProvider({ children }: MotionProviderProps): ReactElement {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
