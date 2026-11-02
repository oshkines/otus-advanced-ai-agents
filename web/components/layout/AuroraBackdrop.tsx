import type { ReactElement } from "react";

/** Звезда-точка шлейфа: позиция в координатах viewBox, радиус и прозрачность. */
interface StarDot {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly opacity: number;
}

/**
 * Параметры эллиптической орбиты: широкий вытянутый овал, нижняя дуга которого
 * проходит по верхней панели и уходит под карточки. `laneOffsets` — смещения
 * «дорожек» по вертикальному радиусу в px: дорожки идут почти параллельно друг
 * другу, поэтому шлейф читается как объёмная структура, а не как одна линия, и
 * не разваливается на вложенные овалы (при больших `ry` множители вроде
 * 0.68 / 0.86 разносили бы дуги на сотни пикселей).
 */
interface EllipticalTrailOptions {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly tilt: number;
  readonly laneOffsets: readonly number[];
  readonly dotsPerLane: number;
  readonly seed: number;
  readonly opacity: number;
}

/**
 * Во сколько раз горизонтальный радиус дорожки растёт вслед за вертикальным
 * смещением: так дорожки остаются почти параллельными дуге горизонта.
 */
const LANE_RX_PER_RY = 2.6;

/** Полуразмах горизонтального градиента нити горизонта (px в координатах viewBox). */
const HORIZON_REACH = 740;

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

  options.laneOffsets.forEach((offset, laneIndex) => {
    const count = Math.round(options.dotsPerLane * (0.82 + laneIndex * 0.12));
    const step = (Math.PI * 2) / count;
    const laneRx = options.rx + offset * LANE_RX_PER_RY;
    const laneRy = options.ry + offset;

    for (let index = 0; index < count; index += 1) {
      const seed = options.seed + laneIndex * 211 + index;
      const angle = index * step + (pseudoNoise(seed) - 0.5) * step * 0.6;
      const radial = 1 + (pseudoNoise(seed + 7) - 0.5) * 0.012;
      const x = Math.cos(angle) * laneRx * radial;
      const y = Math.sin(angle) * laneRy * radial;

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

/** Один шлейф: мягкая дымка по форме овала, разреженные звёзды и линия горизонта. */
function EllipticalTrail({ trail }: { readonly trail: EllipticalTrailOptions }): ReactElement {
  const dots = buildTrailDots(trail);
  /* Нижняя точка орбиты — она же линия горизонта на верхней панели. */
  const limbY = trail.cy + trail.ry;

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
        <filter id={`${trail.id}-glow`} x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation={5} />
        </filter>
        {/*
         * Небо горизонта: заливка внутренней части орбиты. Градиент идёт сверху
         * вниз и обрывается на линии горизонта — над дугой появляется мягкое
         * свечение, а ниже остаётся чистый --color-canvas.
         */}
        <linearGradient
          id={`${trail.id}-sky`}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={limbY - 170}
          x2={0}
          y2={limbY + 6}
        >
          <stop offset="0%" stopColor="#6f86d8" stopOpacity={0} />
          <stop offset="45%" stopColor="#8fa6ff" stopOpacity={0.03} />
          <stop offset="72%" stopColor="#a7bbff" stopOpacity={0.055} />
          <stop offset="88%" stopColor="#c2d4ff" stopOpacity={0.06} />
          <stop offset="100%" stopColor="#dbe7ff" stopOpacity={0.085} />
        </linearGradient>
        {/*
         * Нить горизонта: горизонтальный градиент собирает свечение в центре
         * верхней панели и гасит дугу к краям окна — резких обрывов нет.
         * Пик — не белый, а мягкий серо-голубой #cbd8f4 с прозрачностью 0.56:
         * после общей прозрачности слоя (0.72) дуга остаётся неяркой и не
         * пересвечивает текст заголовка и метаданные (WCAG >= 7:1 на --color-ink).
         */}
        <linearGradient
          id={`${trail.id}-rim`}
          gradientUnits="userSpaceOnUse"
          x1={trail.cx - HORIZON_REACH}
          y1={0}
          x2={trail.cx + HORIZON_REACH}
          y2={0}
        >
          <stop offset="0%" stopColor="#7f8bb8" stopOpacity={0.04} />
          <stop offset="12%" stopColor="#8f9fd6" stopOpacity={0.18} />
          <stop offset="28%" stopColor="#9db0e8" stopOpacity={0.3} />
          <stop offset="42%" stopColor="#b3c5f2" stopOpacity={0.44} />
          <stop offset="50%" stopColor="#cbd8f4" stopOpacity={0.56} />
          <stop offset="58%" stopColor="#b3c5f2" stopOpacity={0.44} />
          <stop offset="72%" stopColor="#9db0e8" stopOpacity={0.3} />
          <stop offset="88%" stopColor="#8f9fd6" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#7f8bb8" stopOpacity={0.1} />
        </linearGradient>
      </defs>

      {/* Небо горизонта: мягкая заливка внутренней части орбиты, ярче у дуги */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx}
        ry={trail.ry}
        fill={`url(#${trail.id}-sky)`}
      />

      {/* Дымка шлейфа: размытые полосы вдоль овала, без «рельсов» и рёбер */}
      <g
        fill="none"
        stroke="#8ea6ff"
        strokeWidth={24}
        opacity={0.08}
        filter={`url(#${trail.id}-soft)`}
      >
        {trail.laneOffsets.map((offset, index) => (
          <ellipse
            key={`${trail.id}-lane-${index}`}
            cx={trail.cx}
            cy={trail.cy}
            rx={trail.rx + offset * LANE_RX_PER_RY}
            ry={trail.ry + offset}
          />
        ))}
      </g>

      {/* Гало по форме овала: подсвечивает структуру, не давая ей «рассыпаться» */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx * 0.9}
        ry={trail.ry * 1.15}
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

      {/* Ореол горизонта: размытая широкая дуга, повторяющая нижнюю часть орбиты */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx}
        ry={trail.ry}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={26}
        opacity={0.16}
        filter={`url(#${trail.id}-soft)`}
      />

      {/* Ближний свет: узкое свечение вокруг нити, держит дугу очерченной */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx}
        ry={trail.ry}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={8}
        opacity={0.36}
        filter={`url(#${trail.id}-glow)`}
      />

      {/* Нить горизонта: тонкая светящаяся дуга, гаснущая к краям окна */}
      <ellipse
        cx={trail.cx}
        cy={trail.cy}
        rx={trail.rx}
        ry={trail.ry}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={1.8}
      />

      {/*
       * Ядро: живёт выше верхней границы окна — в кадр попадает только его
       * отсвет, поэтому за карточками «Модули» нет пересвеченного пятна.
       */}
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
/**
 * Орбита галактики: ядро вынесено далеко за верхнюю границу окна, поэтому в
 * кадр попадает только нижняя часть эллипса — мягкая вытянутая дуга горизонта.
 * `rx` заметно больше половины ширины viewBox: концы дуги уходят за края
 * экрана и не обрываются в видимой области.
 *
 * Инварианты геометрии (проверяются по этим числам, 1 единица viewBox = 1 px):
 * — ядро целиком выше кадра: нижняя кромка `cy + 0.7·ry = -7.8` px < 0, то есть
 *   в кадр попадает только отсвет, а не само ядро;
 * — линия горизонта `cy + ry = 120` px лежит в зазоре между верхней панелью
 *   (заголовок + метаданные, до ~93 px) и заголовком секции, поэтому дуга не
 *   пересекает текст;
 * — центр дуги `cx / VIEW_WIDTH = 60%` совпадает с центром контентной колонки
 *   (сайдбар 256 px слева), а не геометрическим центром окна.
 */
const MAIN_TRAIL: EllipticalTrailOptions = {
  id: "galaxy-trail",
  cx: 860,
  cy: -306,
  rx: 1600,
  ry: 426,
  tilt: 0,
  laneOffsets: [0, 22, 58],
  dotsPerLane: 220,
  seed: 5.3,
  opacity: 0.9,
};

/** Границы viewBox: по ним строится маска горизонтального затухания. */
const VIEW_WIDTH = 1440;
const VIEW_HEIGHT = 440;

/**
 * Декоративный фон: эллиптическая орбита галактики (инлайн-SVG) и северное
 * сияние из плавных градиентных лент с очень медленным циклом 26–33 s.
 *
 * Геометрия фона: ядро галактики вынесено далеко за верхнюю границу окна,
 * поэтому в кадр попадает только нижняя дуга орбиты — она читается как
 * «горизонт событий»: мягкая вытянутая светящаяся дуга в центре верхней
 * панели, концы которой уходят за края окна, а нижние дорожки плавно
 * спускаются под карточки «Модули». mask-градиент гасит шлейф у левого и
 * правого краёв, а нить горизонта собрана в центре, поэтому заголовок «Обзор»
 * и метаданные лежат на затемнённом участке с сохранённым контрастом.
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
        preserveAspectRatio="none"
        fill="none"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          {/* Мягкое затухание к краям экрана: маска по горизонтали */}
          <linearGradient id="galaxy-edge-fade" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
            <stop offset="6%" stopColor="#ffffff" stopOpacity={0.3} />
            <stop offset="14%" stopColor="#ffffff" stopOpacity={0.7} />
            <stop offset="22%" stopColor="#ffffff" stopOpacity={0.93} />
            <stop offset="32%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="68%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="78%" stopColor="#ffffff" stopOpacity={0.93} />
            <stop offset="86%" stopColor="#ffffff" stopOpacity={0.7} />
            <stop offset="94%" stopColor="#ffffff" stopOpacity={0.3} />
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

