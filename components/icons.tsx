"use client";

import {
  BellRing,
  Briefcase,
  Cpu,
  LayoutGrid,
  Mail,
  Radar,
  Rocket,
  ShieldCheck,
  Sparkles,
  TrainFront,
  type LucideIcon,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import type { ReactElement } from "react";

import type { IconName } from "@/lib/orchestrator/types";

/**
 * Единый иконный набор проекта — `lucide-react` (design.md §10: запрещены
 * случайные эмодзи и смешение стилей). Все иконки интерфейса идут через этот
 * модуль, поэтому толщина штриха, размер и `aria-hidden` задаются в одном месте.
 *
 * Бренд-логотип (корабль Trimaxion) — не иконка, а знак: он живёт отдельно в
 * `components/brand/TrimaxionMark.tsx`, чтобы его геометрия не зависела от версии
 * иконного пакета. Здесь `rocket` — обычная иконка lucide для совместимости с
 * конфигом ядра (`icon: "rocket"`).
 */
const DEFAULT_ICON_SIZE = 18;
const ICON_STROKE_WIDTH = 1.6;

const GLYPHS: Readonly<Record<IconName, LucideIcon>> = {
  mail: Mail,
  briefcase: Briefcase,
  train: TrainFront,
  grid: LayoutGrid,
  rocket: Rocket,
  bell: BellRing,
  radar: Radar,
  cpu: Cpu,
  shield: ShieldCheck,
  sparkles: Sparkles,
};

export interface IconProps extends Omit<LucideProps, "ref"> {
  readonly name: IconName;
}

/** Иконка по имени из конфига: одна геометрия и один размер на весь интерфейс. */
export function Icon({ name, ...props }: IconProps): ReactElement {
  const Glyph = GLYPHS[name];

  return (
    <Glyph
      size={DEFAULT_ICON_SIZE}
      strokeWidth={ICON_STROKE_WIDTH}
      absoluteStrokeWidth={false}
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

