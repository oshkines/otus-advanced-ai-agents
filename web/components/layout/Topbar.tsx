import type { ReactElement } from "react";

import { CosmosFullscreenButton } from "@/components/layout/CosmosFullscreenButton";

export interface TopbarProps {
  readonly title: string;
  readonly subtitle: string;
  readonly trailing?: ReactElement;
}

/**
 * Верхняя строка страницы: название канала, контекст и опциональный индикатор.
 *
 * Разделительной линии под шапкой намеренно нет: прямая горизонталь резала
 * космический фон и «горизонт событий» поперёк. Воздух между шапкой и телом
 * страницы держат только отступы, поэтому дуга горизонта проходит под
 * заголовком непрерывно.
 *
 * В правом углу всегда стоит кнопка-заглушка «полноэкранный космос»: она
 * компактна, оформлена токенами дизайн-системы и не конкурирует со статус-бейджем
 * (`trailing`), который остаётся первым в группе.
 */
export function Topbar({ title, subtitle, trailing }: TopbarProps): ReactElement {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 pb-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-8 tracking-tight">{title}</h1>
        <p className="mt-1 text-sm leading-5 text-muted">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {trailing ?? null}
        <CosmosFullscreenButton />
      </div>
    </header>
  );
}
