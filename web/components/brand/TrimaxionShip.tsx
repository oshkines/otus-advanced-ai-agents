import type { ReactElement } from "react";

export interface TrimaxionShipProps {
  readonly className?: string;
}

/**
 * Корпус-веретено: остриё слева (нос), симметричная гладкая корма справа.
 *
 * Геометрия строго зеркальна относительно оси y = 48 — никаких боковых
 * плавников и стабилизаторов: обтекаемая капля с острым носом, максимальная
 * толщина в районе x = 118 и узкая дюза на корме (x = 228).
 */
const HULL_PATH =
  "M4 48 C30 29 74 17 118 17 C160 17 192 26 208 37 L222 44 C226 45.5 228 46.5 228 48 C228 49.5 226 50.5 222 52 L208 59 C192 70 160 79 118 79 C74 79 30 67 4 48 Z";

/** Шов обшивки (шпангоут): дуга поперёк корпуса. */
const TOP_SEAM_PATH = "M86 30 C92 38 92 58 86 66";

/** Второй шов ближе к корме — панельный металл без симметричных «перьев». */
const STERN_SEAM_PATH = "M150 22 C156 34 156 62 150 74";

/** Верхняя половина остекления: тонкий клин вдоль позвоночной оси. */
const GLASS_TOP_PATH = "M50 44 C74 37 104 34 126 35 L126 39 C104 38 76 41 52 48 Z";

/** Нижняя половина остекления — зеркальная копия относительно y = 48. */
const GLASS_BOTTOM_PATH = "M50 52 C74 59 104 62 126 61 L126 57 C104 58 76 55 52 48 Z";

/**
 * Силуэт корабля Trimaxion (Max) для пасхалки «в глубине горизонта событий».
 *
 * Силуэт намеренно «не рыбий»: ни боковых плавников, ни раздвоенного хвоста —
 * только гладкое симметричное веретено с острым носом. Материал — жидкий хром:
 * плотная металлическая заливка (графит `#0B1220` → сталь → серебряный блик
 * `#E2E8F0`) плюс ледяной акцент `#38BDF8` по кромкам и в дюзе. Прозрачной
 * «проволочной» обводки нет: контур держат тонкая тень кромки и узкий холодный
 * specular-блик, поэтому на 16–32 px силуэт читается как цельный металл.
 *
 * Группа `trimaxion-glint` — переливающаяся световая полоса, обрезанная по
 * корпусу; её смещение и яркость приходят из CSS-переменных, которые анимирует
 * `TrimaxionPassage` (`.trimaxion-glint` в globals.css), поэтому металл
 * «играет» именно в движении, без постоянных CSS-анимаций.
 *
 * Все градиенты лежат в defs с префиксом `trimaxion-`: компонент монтируется
 * в единственном экземпляре, конфликтов id с другими SVG нет.
 */
export function TrimaxionShip({ className }: TrimaxionShipProps): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 240 96"
      fill="none"
      focusable="false"
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        {/* Основной тон корпуса: графит в тени → серебро на блике */}
        <linearGradient id="trimaxion-chrome" x1="0.12" y1="1" x2="0.58" y2="0">
          <stop offset="0%" stopColor="#0B1220" />
          <stop offset="20%" stopColor="#1E293B" />
          <stop offset="42%" stopColor="#475569" />
          <stop offset="64%" stopColor="#94A3B8" />
          <stop offset="84%" stopColor="#E2E8F0" />
          <stop offset="100%" stopColor="#F8FAFC" />
        </linearGradient>
        {/* Ледяной акцент: холодный отсвет по кромкам корпуса */}
        <linearGradient id="trimaxion-ice" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.38" />
          <stop offset="42%" stopColor="#38BDF8" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#0B1220" stopOpacity="0.42" />
        </linearGradient>
        {/* Узкий холодный блик по верхней кромке */}
        <linearGradient id="trimaxion-specular" x1="0" y1="0" x2="1" y2="0.2">
          <stop offset="0%" stopColor="#E2E8F0" stopOpacity="0" />
          <stop offset="24%" stopColor="#E2E8F0" stopOpacity="0.75" />
          <stop offset="62%" stopColor="#BAE6FD" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.35" />
        </linearGradient>
        {/* Позвоночная грань: светящаяся ось от носа к дюзе */}
        <linearGradient id="trimaxion-spine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#E2E8F0" stopOpacity="0" />
          <stop offset="30%" stopColor="#E2E8F0" stopOpacity="0.55" />
          <stop offset="72%" stopColor="#BAE6FD" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.2" />
        </linearGradient>
        {/* Переливающаяся полоса: белое ядро и холодная голубая кромка */}
        <linearGradient id="trimaxion-glint" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#E2E8F0" stopOpacity="0" />
          <stop offset="40%" stopColor="#E2E8F0" stopOpacity="0.45" />
          <stop offset="52%" stopColor="#FFFFFF" stopOpacity="0.75" />
          <stop offset="64%" stopColor="#38BDF8" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
        </linearGradient>
        {/* Остекление: тёмное стекло с ледяной подсветкой */}
        <linearGradient id="trimaxion-glass" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor="#0EA5E9" stopOpacity="0.55" />
          <stop offset="52%" stopColor="#38BDF8" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#E0F2FE" stopOpacity="0.9" />
        </linearGradient>
        {/* Ядро блика: сюда «перетекает» далёкая точка при подходе корабля */}
        <radialGradient id="trimaxion-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="34%" stopColor="#BAE6FD" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
        </radialGradient>
        {/* Дюзовое свечение */}
        <radialGradient id="trimaxion-exhaust" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#E0F2FE" stopOpacity="0.95" />
          <stop offset="46%" stopColor="#38BDF8" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0" />
        </radialGradient>
        <clipPath id="trimaxion-hull-clip">
          <path d={HULL_PATH} />
        </clipPath>
      </defs>

      {/* Корпус: хром и ледяной отсвет — силуэт без плавников */}
      <path
        d={HULL_PATH}
        fill="url(#trimaxion-chrome)"
        stroke="#0F172A"
        strokeOpacity="0.55"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <path d={HULL_PATH} fill="url(#trimaxion-ice)" />

      {/* Перелив: полоса света, обрезанная по корпусу; смещается через CSS-переменную */}
      <g clipPath="url(#trimaxion-hull-clip)" className="trimaxion-glint">
        <rect x="-96" y="0" width="150" height="96" fill="url(#trimaxion-glint)" />
      </g>

      {/* Швы обшивки: тёмный шов и светлая грань рядом — панельный металл */}
      <path d={TOP_SEAM_PATH} stroke="#0F172A" strokeOpacity="0.42" strokeWidth="0.7" />
      <path d={STERN_SEAM_PATH} stroke="#0F172A" strokeOpacity="0.34" strokeWidth="0.6" />
      <path d="M87 31 C93 38 93 58 87 65" stroke="#CBD5E1" strokeOpacity="0.22" strokeWidth="0.5" />

      {/* Остекление: парные клинья вдоль оси — силуэт остаётся симметричным */}
      <path
        d={GLASS_TOP_PATH}
        fill="url(#trimaxion-glass)"
        stroke="#E0F2FE"
        strokeOpacity="0.45"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      <path
        d={GLASS_BOTTOM_PATH}
        fill="url(#trimaxion-glass)"
        stroke="#E0F2FE"
        strokeOpacity="0.25"
        strokeWidth="0.45"
        strokeLinejoin="round"
        opacity="0.7"
      />

      {/* Дюза на корме: металлический блок и раскалённое сопло */}
      <path
        d="M210 43 L224 45 L224 51 L210 53 Z"
        fill="url(#trimaxion-chrome)"
        stroke="#0F172A"
        strokeOpacity="0.5"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
      <ellipse cx="223.5" cy="48" rx="3.6" ry="4.6" fill="url(#trimaxion-exhaust)" />
      <ellipse cx="223.5" cy="48" rx="1.4" ry="2.2" fill="#E0F2FE" fillOpacity="0.95" />

      {/* Позвоночная грань и specular: корпус читается как острая металлическая кромка */}
      <path d="M14 48 L212 48" stroke="url(#trimaxion-spine)" strokeWidth="0.8" />
      <path
        d="M18 41 C40 29 76 21 118 20 C156 19 188 27 206 36"
        stroke="url(#trimaxion-specular)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M46 27 C72 21 100 18 126 18 C154 18 180 24 198 32"
        stroke="#E0F2FE"
        strokeOpacity="0.6"
        strokeWidth="0.55"
        strokeLinecap="round"
      />
      <path
        d="M18 55 C40 67 76 75 118 76 C156 77 188 69 206 60"
        stroke="#38BDF8"
        strokeOpacity="0.34"
        strokeWidth="0.9"
        strokeLinecap="round"
      />

      {/* Ядро блика: далёкий корабль «горит» точкой, при подходе гаснет */}
      <ellipse
        cx="118"
        cy="48"
        rx="30"
        ry="9"
        fill="url(#trimaxion-core)"
        className="trimaxion-core"
      />
    </svg>
  );
}
