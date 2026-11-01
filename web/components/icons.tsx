import type { ReactElement, SVGProps } from "react";

import type { IconName } from "@/lib/orchestrator/types";

type SvgProps = SVGProps<SVGSVGElement>;

function SvgBase({ children, ...props }: SvgProps & { children: ReactElement }): ReactElement {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

function GridGlyph(): ReactElement {
  return (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  );
}

function MailGlyph(): ReactElement {
  return (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7.5 8.5 5.5 8.5-5.5" />
    </>
  );
}

function BriefcaseGlyph(): ReactElement {
  return (
    <>
      <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
      <path d="M8.5 7.5V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" />
      <path d="M3 12.5h18" />
    </>
  );
}

function TrainGlyph(): ReactElement {
  return (
    <>
      <rect x="5" y="3" width="14" height="13" rx="3.5" />
      <path d="M5 9.5h14" />
      <path d="M9 20l-1.5 1.5" />
      <path d="M15 20l1.5 1.5" />
      <path d="M8 16.5h8" />
    </>
  );
}

/**
 * Космический маркер бренда: корабль Max (Trimaxion Drone Ship) из «Полёта навигатора».
 * Обтекаемая капля с острым носом слева, куполом кабины, дюзой на корме и
 * раздвоенным симметричным хвостом-стабилизатором справа. Силуэт симметричен
 * относительно оси y = 12 и читается на 18 px так же, как соседние пункты меню.
 */
function TrimaxionGlyph(): ReactElement {
  return (
    <>
      {/* Корпус-капля: остриё слева, скруглённая корма справа */}
      <path d="M2.6 12C6.6 9.4 10.6 7.8 14 7.8c2.6 0 4.6 1.6 5.2 3.6v1.2c-.6 2-2.6 3.6-5.2 3.6-3.4 0-7.4-1.6-11.4-4.2Z" />
      {/* Купол кабины на верхней кромке */}
      <path d="M7.6 8.9c.6-2 3.2-2.3 4.4-.7" />
      {/* Дюза на корме */}
      <path d="M17.4 10.8v2.4" />
      {/* Раздвоенный хвост-стабилизатор */}
      <path d="M16.8 8.6 21.8 5.8 18.6 10.4Z" />
      <path d="M16.8 15.4 21.8 18.2 18.6 13.6Z" />
    </>
  );
}

/** Инлайн-иконки: без внешних иконных пакетов (минимум зависимостей проекта). */
export function Icon({ name, ...props }: SvgProps & { name: IconName }): ReactElement {
  switch (name) {
    case "mail":
      return (
        <SvgBase {...props}>
          <MailGlyph />
        </SvgBase>
      );
    case "briefcase":
      return (
        <SvgBase {...props}>
          <BriefcaseGlyph />
        </SvgBase>
      );
    case "train":
      return (
        <SvgBase {...props}>
          <TrainGlyph />
        </SvgBase>
      );
    case "rocket":
      return (
        <SvgBase {...props}>
          <TrimaxionGlyph />
        </SvgBase>
      );
    case "grid":
    default:
      return (
        <SvgBase {...props}>
          <GridGlyph />
        </SvgBase>
      );
  }
}
