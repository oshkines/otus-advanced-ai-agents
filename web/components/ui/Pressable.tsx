"use client";

import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactElement, ReactNode } from "react";

/** Кривая design.md §8 для микро-взаимодействий кнопок. */
const EASE_STANDARD: [number, number, number, number] = [0.4, 0, 0.2, 1];

const PRESS_TRANSITION = { duration: 0.16, ease: EASE_STANDARD } as const;

export interface PressableProps extends Omit<HTMLMotionProps<"button">, "children"> {
  readonly children: ReactNode;
}

/**
 * Кнопка с мягким hover/tap-откликом (design.md §5: Active = scale 0.98).
 *
 * Единая точка правды для всех активных кнопок интерфейса: отклик сдвигом на
 * 1 px и сжатием до 0.98, длительность 160 ms. `reducedMotion="user"` в
 * `MotionProvider` сам отключит transform для пользователей, попросивших
 * уменьшить движение. Заблокированная кнопка не откликается вовсе —
 * это важно для состояний `pending`/`disabled`, где клик запрещён.
 */
export function Pressable({
  children,
  disabled = false,
  type = "button",
  ...props
}: PressableProps): ReactElement {
  return (
    <motion.button
      type={type}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={PRESS_TRANSITION}
      {...props}
    >
      {children}
    </motion.button>
  );
}
