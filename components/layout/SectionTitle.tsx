import type { ReactElement, ReactNode } from "react";

export interface SectionTitleProps {
  readonly children: ReactNode;
  readonly hint?: string;
}

/** H2 секции bento (18/24 Semi-Bold) с необязательной подсказкой (Caption 12/16). */
export function SectionTitle({ children, hint }: SectionTitleProps): ReactElement {
  return (
    <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-lg font-semibold leading-6">{children}</h2>
      {hint === undefined ? null : <p className="text-xs leading-4 text-muted">{hint}</p>}
    </div>
  );
}
