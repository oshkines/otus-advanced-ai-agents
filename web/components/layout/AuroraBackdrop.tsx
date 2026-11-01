import type { ReactElement } from "react";

/** Звезда-точка шлейфа: позиция в координатах viewBox, радиус и прозрачность. */
interface StarDot {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly opacity: number;
}

/**
 * Параметры эллиптического шлейфа: широкий вытянутый овал, который плавно
 * расходится влево и вправо по верхней панели. `lanes` — относительные радиусы
 * «дорожек» внутри овала (0.68 / 0.86 / 1), за счёт них шлейф читается как
 * объёмная структура, а не как одна линия.
 */
interface EllipticalTrailOptions {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly tilt: number;
  readonly lanes: readonly number[];
  readonly dotsPerLane: number;
  readonly seed: number;
  readonly opacity: number;
}

/**
 * Детерминированный псевдошум: одинаковый результат на сервере и клиенте,
 * поэтому разметка галактик стабильна между рендерами (никаких Math.random).
 */
function pseudoNoise(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Точки вдоль эллиптической орбиты.
 *
 * Шаг по углу постоянный (`2π / count`), поэтому соседние звёзды не слипаются в
 * единое яркое пятно: расстояние между ними предсказуемо и одинаково вдоль
 * всего овала. Небольшой джиттер (±30% шага) убирает «механическую»
 * регулярность. Яркость зависит от удалённости от концов овала: в центре шлейф
 * светлее, к краям гаснет — вместе с mask-градиентом это даёт мягкий fade out
 * к границам экрана.
 */
function buildTrailDots(options: EllipticalTrailOptions): readonly StarDot[] {
  const dots: StarDot[] = [];
  const tiltRadians = (options.tilt * Math.PI) / 180;
  const cosTilt = Math.cos(tiltRadians);
  const sinTilt = Math.sin(tiltRadians);

  options.lanes.forEach((lane, laneIndex) => {
    const count = Math.round(options.dotsPerLane * (0.78 + laneIndex * 0.16));
    const step = (Math.PI * 2) / count;

    for (let index = 0; index < count; index += 1) {
      const seed = options.seed + laneIndex * 211 + index;
      const angle = index * step + (pseudoNoise(seed) - 0.5) * step * 0.6;
      const radial = lane * (1 + (pseudoNoise(seed + 7) - 0.5) * 0.05);
      const x = Math.cos(angle) * options.rx * radial;
      const y = Math.sin(angle) * options.ry * radial;

      /* 1 у концов овала (там звёзды гаснут), 0 в центре (там ярче) */
      const edge = Math.abs(Math.cos(angle));
      const glow = 1 - Math.pow(edge, 2.4);
      const isBright = pseudoNoise(seed + 31) > 0.9;

      dots.push({
        cx: options.cx + x * cosTilt - y * sinTilt,
        cy: options.cy + x * sinTilt + y * cosTilt,
        r: (isBright ? 1.9 : 0.8) + pseudoNoise(seed + 21) * 0.7,
        opacity:
          (isBright ? 0.55 : 0.24) + (isBright ? 0.22 : 0.26) * glow + pseudoNoise(seed + 29) * 0.12,
      });
    }
  });

  return dots;
}

/** Один шлейф: мягкая дымка по форме овала, разреженные звёзды и светящееся ядро. */
function EllipticalTrail({ trail }: { readonly trail: EllipticalTrailOptions }): ReactElement {
  const dots = buildTrailDots(trail);

  return (
    <g opacity={trail.opacity} transform={`rotate(${trail.tilt} ${trail.cx} ${trail.cy})`}>
      <defs>
        <radialGradient id={`${trail.id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8fa6ff" stopOpacity={0.16} />
          <stop offset="46%" stopColor="#6274d2" stopOpacity={0.075} />
          <stop offset="100%" stopColor="#37457f" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${trail.id}-dust`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.92} />
          <stop offset="42%" stopColor="#dfeaff" stopOpacity={0.78} />
          <stop offset="78%" stopColor="#a8bcff" stopOpacity={0.58} />
          <stop offset="100%" stopColor="#7f93e6" stopOpacity={0.36} />
        </radialGradient>
        <radialGradient id={`${trail.id}-core`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.1} />
          <stop offset="38%" stopColor="#dbebff" stopOpacity={0.05} />
          <stop offset="72%" stopColor="#9fb8ff" stopOpacity={0.02} />
          <stop offset="100%" stopColor="#7d92e0" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${trail.id}-beam`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.14} />
          <stop offset="45%" stopColor="#eaf2ff" stopOpacity={0.07} />
          <stop offset="100%" stopColor="#c9dcff" stopOpacity={0} />
        </radialGradient>
        <filter id={`${trail.id}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation={12} />
        </filter>
      </defs>

      {/* Дымка шлейфа: размытые полосы вдоль овала, без «рельсов» и рёбер */}
      <g
        fill="none"
        stroke="#8ea6ff"
        strokeWidth={26}
        opacity={0.09}
        filter={`url(#${trail.id}-soft)`}
      >
        {trail.lanes.map((lane, index) => (
          <ellipse
            key={`${trail.id}-lane-${index}`}
            cx={trail.cx}
            cy={trail.cy}
            rx={trail.rx * lane}
            ry={trail.ry * lane}
          />
        ))}
      </g>

      {/* Гало по форме овала: подсвечивает структуру, не давая ей «рассыпаться» */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx * 0.82}
        ry={trail.ry * 1.2}
        fill={`url(#${trail.id}-halo)`}
      />

      {/* Разреженные звёзды-точки: аккуратный космический шлейф */}
      <g fill={`url(#${trail.id}-dust)`}>
        {dots.map((dot, index) => (
          <circle
            key={`${trail.id}-dot-${index}`}
            cx={dot.cx}
            cy={dot.cy}
            r={dot.r}
            opacity={dot.opacity}
          />
        ))}
      </g>

      {/* Ядро: мягкое свечение без жёстких границ, чтобы не спорить с заголовком */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx * 0.24}
        ry={trail.ry * 0.7}
        fill={`url(#${trail.id}-core)`}
      />
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx * 0.07}
        ry={trail.ry * 0.2}
        fill={`url(#${trail.id}-beam)`}
      />
    </g>
  );
}
/** Широкий вытянутый шлейф: расходится влево и вправо по всей верхней панели. */
const MAIN_TRAIL: EllipticalTrailOptions = {
  id: "galaxy-trail",
  cx: 720,
  cy: 236,
  rx: 648,
  ry: 88,
  tilt: -3,
  lanes: [0.68, 0.86, 1],
  dotsPerLane: 76,
  seed: 5.3,
  opacity: 0.9,
};

/** Границы viewBox: по ним строится маска горизонтального затухания. */
const VIEW_WIDTH = 1440;
const VIEW_HEIGHT = 440;

/**
 * Декоративный фон: эллиптический галактический шлейф (инлайн-SVG) и северное
 * сияние из плавных градиентных лент с очень медленным циклом 26–33 s.
 *
 * Геометрия фона: овал вытянут по горизонтали и расходится по всей верхней
 * панели, звёзды разрежены (постоянный шаг по углу), а mask-градиент гасит
 * шлейф у левого и правого краёв — переход в фон без резких обрывов.
 *
 * Инварианты контраста (WCAG >= 7:1): слой живёт в отдельном контексте
 * `z-index: 0`, а контент AppShell поднят на `z-index: 10` и лежит на
 * непрозрачных `--color-canvas` / `--color-surface`. Все заливки фона
 * низкоальфные, общая прозрачность слоя ограничена, а `mask-image` гасит фон
 * вниз экрана — светимость под текстом остаётся низкой, поэтому `--color-ink`
 * сохраняет расчётный контраст выше 7:1. При `prefers-reduced-motion`
 * анимации отключаются (правило в globals.css).
 */
export function AuroraBackdrop(): ReactElement {
  return (
    <div aria-hidden="true" data-testid="aurora-backdrop" className="aurora-backdrop">
      <svg
        className="galaxy-cluster"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        fill="none"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          {/* Мягкое затухание к краям экрана: маска по горизонтали */}
          <linearGradient id="galaxy-edge-fade" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
            <stop offset="15%" stopColor="#ffffff" stopOpacity={0.8} />
            <stop offset="32%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="68%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="85%" stopColor="#ffffff" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </linearGradient>
          <mask
            id="galaxy-edge-mask"
            maskUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={VIEW_WIDTH}
            height={VIEW_HEIGHT}
          >
            <rect
              x={0}
              y={0}
              width={VIEW_WIDTH}
              height={VIEW_HEIGHT}
              fill="url(#galaxy-edge-fade)"
            />
          </mask>
        </defs>

        <g mask="url(#galaxy-edge-mask)">
          <EllipticalTrail trail={MAIN_TRAIL} />
        </g>
      </svg>

      <span className="aurora-ribbon aurora-ribbon--midnight animate-aurora-a" />
      <span className="aurora-ribbon aurora-ribbon--violet animate-aurora-b" />
      <span className="aurora-ribbon aurora-ribbon--ember animate-aurora-c" />
      <span className="aurora-ribbon aurora-ribbon--veil animate-aurora-a" />
      <span className="aurora-rays animate-aurora-d" />
    </div>
  );
}

