import type { ReactElement } from "react";

export interface TrimaxionMarkProps {
  readonly className?: string;
  readonly size?: number;
}

/**
 * Бренд-знак AI Dev Navigator: корабль Max (Trimaxion Drone Ship) из
 * «Полёта навигатора».
 *
 * Это логотип, а не иконка интерфейса: обтекаемая капля с острым носом слева,
 * куполом кабины, дюзой на корме и раздвоенным симметричным хвостом-стабилизатором
 * справа. Силуэт симметричен относительно оси y = 12 и читается на 18 px так же,
 * как соседние пункты меню (иконки меню — lucide-react, см. `components/icons.tsx`).
 * Геометрия 1:1 продублирована в `app/icon.svg` (favicon).
 */
export function TrimaxionMark({ className, size = 18 }: TrimaxionMarkProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Корпус-капля: остриё слева, скруглённая корма справа */}
      <path d="M2.6 12C6.6 9.4 10.6 7.8 14 7.8c2.6 0 4.6 1.6 5.2 3.6v1.2c-.6 2-2.6 3.6-5.2 3.6-3.4 0-7.4-1.6-11.4-4.2Z" />
      {/* Купол кабины на верхней кромке */}
      <path d="M7.6 8.9c.6-2 3.2-2.3 4.4-.7" />
      {/* Дюза на корме */}
      <path d="M17.4 10.8v2.4" />
      {/* Раздвоенный хвост-стабилизатор */}
      <path d="M16.8 8.6 21.8 5.8 18.6 10.4Z" />
      <path d="M16.8 15.4 21.8 18.2 18.6 13.6Z" />
    </svg>
  );
}
