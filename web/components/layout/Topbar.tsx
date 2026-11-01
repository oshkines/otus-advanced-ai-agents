import type { ReactElement } from "react";

export interface TopbarProps {
  readonly title: string;
  readonly subtitle: string;
  readonly trailing?: ReactElement;
}

/** Верхняя строка страницы: название канала, контекст и опциональный индикатор. */
export function Topbar({ title, subtitle, trailing }: TopbarProps): ReactElement {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-8 tracking-tight">{title}</h1>
        <p className="mt-1 text-sm leading-5 text-muted">{subtitle}</p>
      </div>
      {trailing ?? null}
    </header>
  );
}
