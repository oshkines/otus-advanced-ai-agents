import type { ReactElement } from "react";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { IconName } from "@/lib/orchestrator/types";

export interface ModuleCardProps {
  readonly icon: IconName;
  readonly index: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly bullets: readonly string[];
  readonly className?: string;
}

/**
 * Карточка модуля на публичной странице `/overview`.
 *
 * Геометрия — та же, что у bento-карточек дашборда (`rounded-bento` = 12 px,
 * `bg-surface` #161B22, `border-border` #30363D), чтобы публичная страница и
 * продукт читались как одна система. Иконки — единый набор `lucide-react`
 * через `components/icons.tsx` (design.md §10: без эмодзи и смешения стилей).
 * Градиентов на поверхности нет — только плоская заливка (design.md §10).
 */
export function ModuleCard({
  icon,
  index,
  title,
  tagline,
  description,
  bullets,
  className,
}: ModuleCardProps): ReactElement {
  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-bento border border-border bg-surface p-5",
        "transition-colors hover:border-primary/40",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-control border border-border bg-canvas text-primary"
        >
          <Icon name={icon} />
        </span>
        <span className="font-mono text-[11px] leading-4 tracking-[0.2em] text-idle">{index}</span>
      </div>

      <h3 className="mt-4 text-base font-semibold leading-6 text-ink">{title}</h3>
      <p className="mt-1 font-mono text-[11px] leading-4 uppercase tracking-[0.12em] text-primary">
        {tagline}
      </p>
      <p className="mt-3 text-sm leading-6 text-muted">{description}</p>

      <ul className="mt-4 space-y-1.5 border-t border-line/60 pt-3">
        {bullets.map((bullet) => (
          <li key={bullet} className="flex gap-2 text-xs leading-5 text-muted">
            <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-idle" />
            <span className="min-w-0">{bullet}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
