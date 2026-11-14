"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef, type ReactElement } from "react";

import { TrimaxionPassage } from "@/components/layout/TrimaxionPassage";

/** Границы viewBox фона: по ним строятся маска затухания и звёздное поле. */
const VIEW_WIDTH = 1440;
const VIEW_HEIGHT = 440;

/**
 * Звезда звёздного поля: позиция в координатах viewBox, радиус и прозрачность.
 * Числа хранятся строками с тремя знаками после запятой (`.toFixed(3)`): ровно
 * эта строка попадает в атрибуты `cx` / `cy` / `r` / `opacity`, поэтому SSR и
 * гидратация выдают побитово одинаковую разметку и React не сообщает о
 * Hydration Mismatch из-за разницы float-округлений.
 */
interface StarDot {
  readonly cx: string;
  readonly cy: string;
  readonly r: string;
  readonly opacity: string;
  /** Редкая одиночная звезда (2 px) с мягким ореолом, а не мелкая пыль. */
  readonly bright: boolean;
}

/**
 * Параметры галактического ядра: широкий вытянутый эллипс, нижняя дуга которого
 * проходит по верхней панели и уходит под карточки. `cx` / `cy` / `rx` / `ry`
 * задают геометрию ядра и мягких заливок (небо, гало, отсвет), а сами дуги
 * горизонта строятся отдельно — замкнутыми кривыми Безье
 * (`NEAR_HORIZON_PATH` / `FAR_HORIZON_PATH`). `laneOffsets` — вертикальные
 * смещения «дорожек» в px: каждая дорожка — та же нить горизонта, опущенная на
 * `offset`, поэтому дорожки параллельны друг другу и дугам и не разваливаются
 * на вложенные овалы.
 */
interface EllipticalTrailOptions {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly laneOffsets: readonly number[];
  readonly opacity: number;
}

/**
 * Эллиптическая область плотности звёздного поля: `weight` > 0 — скопление,
 * `weight` < 0 — тёмная космическая пустота (гасит плотность вокруг центра).
 */
interface DensityBlob {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly weight: number;
}

/**
 * Полуразмах горизонтального градиента нити горизонта (px в координатах viewBox).
 */
const HORIZON_REACH = 740;

/**
 * Ближняя дуга: полуразмах «бусины» — участка в центральной трети экрана, где
 * нить горизонта чуть плотнее и ярче. За его пределами прозрачность падает до
 * нуля, поэтому дуга остаётся тонкой и плавно утончается к краям окна.
 */
const HORIZON_CORE_REACH = 330;

/**
 * Замкнутый «горизонт событий»: передняя и задняя дуги — по две квадратичные
 * кривые Безье, у которых АБСОЛЮТНО одинаковые точки схода: левая кромка
 * (`0; 53`) и правая (`1440; 90.2`). Различаются только Y-координаты
 * управляющих точек в центральной части экрана: 120 у передней нити против
 * 90 у задней. Поэтому эллипс замкнут с обеих сторон: дуги входят в одну и ту
 * же точку на кромках кадра, не пересекаются «ножницами» и не расходятся
 * клином, как два независимых овала.
 *
 * Задняя дуга поднята на 30 px над передней (раньше — на 20): купол верхней
 * (дальней) кромки эллипса читается выразительнее, но её центральная часть
 * остаётся ниже строки подзаголовка верхней панели (`~92 px`), поэтому текст
 * «Обзор» и метаданные не пересекаются даже с мягким ореолом свечения.
 *
 * Разница двух кривых с общими концами и общими X-координатами управляющих
 * точек равна `2·t·(1−t)·ΔY`, поэтому она строго неотрицательна и обращается в
 * ноль только на кромках: пересечение дуг геометрически невозможно.
 *
 * Вершина обеих дуг стоит на `HORIZON_APEX_X = 0.6` ширины — это центр
 * контентной колонки (сайдбар 256 px слева). Квадратичная кривая описывает
 * ровно ту же параболу, по которой летит Trimaxion (`HORIZON_APEX_Y` /
 * `HORIZON_EDGE_DROP` в TrimaxionPassage.tsx), поэтому корабль идёт строго по
 * ближней нити горизонта.
 */
const HORIZON_APEX_X = 864;
const HORIZON_APEX_Y = 120;
const HORIZON_FAR_APEX_Y = 90;
const HORIZON_EDGE_LEFT_Y = 53;
const HORIZON_EDGE_RIGHT_Y = 90.2;

/**
 * Дуга горизонта одним непрерывным путём: левая кромка → вершина → правая
 * кромка. X-координаты управляющих точек — ровно середины половин, поэтому
 * `x(t)` линейна, а кривая совпадает с параболой горизонта. Функция общая для
 * передней и задней дуг: крайние точки совпадают по определению, а в вершине
 * обе управляющие точки лежат на одной высоте, так что стык гладкий.
 */
function horizonArcPath(apexY: number): string {
  const leftControlX = Math.round(HORIZON_APEX_X * 0.5);
  const rightControlX = Math.round(HORIZON_APEX_X + (VIEW_WIDTH - HORIZON_APEX_X) * 0.5);
  const apex = roundTenth(apexY);

  return (
    `M 0 ${HORIZON_EDGE_LEFT_Y} ` +
    `Q ${leftControlX} ${apex} ${HORIZON_APEX_X} ${apex} ` +
    `Q ${rightControlX} ${apex} ${VIEW_WIDTH} ${HORIZON_EDGE_RIGHT_Y}`
  );
}

/**
 * Y-координата ближней нити горизонта для произвольного X: та же парабола, что
 * и в `NEAR_HORIZON_PATH`, но разложенная по X. Нужна бегущей искре, чтобы она
 * шла строго по светящейся линии, а не по её приближению.
 */
function nearHorizonY(x: number): number {
  if (x <= HORIZON_APEX_X) {
    const t = Math.min(Math.max(x / HORIZON_APEX_X, 0), 1);
    const inverse = 1 - t;

    return (
      inverse * inverse * HORIZON_EDGE_LEFT_Y +
      2 * t * inverse * HORIZON_APEX_Y +
      t * t * HORIZON_APEX_Y
    );
  }

  const t = Math.min(Math.max((x - HORIZON_APEX_X) / (VIEW_WIDTH - HORIZON_APEX_X), 0), 1);
  const inverse = 1 - t;

  return (
    inverse * inverse * HORIZON_APEX_Y +
    2 * t * inverse * HORIZON_APEX_Y +
    t * t * HORIZON_EDGE_RIGHT_Y
  );
}

/** Ближняя нить горизонта: провисает до 120 px в центре контентной колонки. */
const NEAR_HORIZON_PATH = horizonArcPath(HORIZON_APEX_Y);

/** Задняя дуга: те же точки схода, но вершина и контрольные точки на 30 px выше. */
const FAR_HORIZON_PATH = horizonArcPath(HORIZON_FAR_APEX_Y);

/**
 * Бегущий импульс ближней дуги: белая точка-искра неспешно скользит по
 * центральному сегменту горизонта слева направо (9–13 s), а свечение дуги в
 * это время мягко усиливается и возвращается к спокойному состоянию. Между
 * пробегами — пауза 3–6 s, чтобы движение не превращалось в конвейер.
 */
const HORIZON_SPARK_TRAVEL_MIN_SEC = 9;
const HORIZON_SPARK_TRAVEL_MAX_SEC = 13;
const HORIZON_SPARK_PAUSE_MIN_SEC = 3;
const HORIZON_SPARK_PAUSE_MAX_SEC = 6;

/** Пиковая прозрачность усиления дуги: чуть ярче спокойного состояния. */
const HORIZON_PULSE_PEAK = 0.38;

/**
 * Полуразмах пробега искры: 82% «бусины», то есть ровно центральный сегмент
 * дуги. Искра входит в него слева и растворяется в линии у правого края.
 */
const HORIZON_SPARK_REACH = HORIZON_CORE_REACH * 0.82;

/**
 * Живой космос: звёзды-пульсары (цефеиды) в разных зонах неба, включая область
 * над горизонтом. Периоды разные (4–9 s) и сдвинуты по фазе, поэтому небо
 * мерцает асинхронно и не выглядит статичным снимком.
 */
interface PulsarStar {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly period: number;
  readonly phase: number;
}

const COSMOS_PULSARS: readonly PulsarStar[] = [
  { cx: 176, cy: 46, r: 2.3, period: 5.4, phase: 0 },
  { cx: 412, cy: 96, r: 1.9, period: 7.1, phase: 1.4 },
  { cx: 668, cy: 34, r: 2.6, period: 4.3, phase: 2.6 },
  { cx: 958, cy: 82, r: 2, period: 8.2, phase: 0.7 },
  { cx: 1236, cy: 52, r: 2.4, period: 6.2, phase: 3.1 },
  { cx: 802, cy: 168, r: 1.8, period: 4.8, phase: 2 },
  { cx: 1132, cy: 238, r: 2.1, period: 8.9, phase: 3.8 },
];

/** Далёкая комета: пауза 45–70 s, полёт 16–22 s — медленно и в противовес кораблю. */
const COMET_GAP_MIN_SEC = 45;
const COMET_GAP_MAX_SEC = 70;
const COMET_TRAVEL_MIN_SEC = 16;
const COMET_TRAVEL_MAX_SEC = 22;

/**
 * Сверхновая: первый взрыв — в окне 30–50 s после загрузки страницы (разгорание
 * стартует через 30–45 s и занимает 4.6 s), чтобы событие можно было увидеть без
 * пятиминутного ожидания; дальше — раз в 240–300 s (4–5 минут).
 * Осколки живут 3–4 s.
 */
const SUPERNOVA_FIRST_MIN_SEC = 30;
const SUPERNOVA_FIRST_MAX_SEC = 45;
const SUPERNOVA_GAP_MIN_SEC = 240;
const SUPERNOVA_GAP_MAX_SEC = 300;
const SUPERNOVA_RISE_SEC = 4.6;
const SUPERNOVA_SPARK_COUNT = 14;

/**
 * Раскалённый гигант: радиус ядра звезды в координатах viewBox (1 unit = 1 px).
 * К диаметру ядра добавляется мягкое гало градиента, поэтому суммарный размер
 * вспышки — ~36–40 px, то есть около 1 см на экране.
 */
const SUPERNOVA_CORE_RADIUS = 7.6;
const SUPERNOVA_GLOW_RADIUS = 19;

/**
 * Дыхание туманности: цикл ~20 s, перепад прозрачности 0.15 ↔ 0.45.
 * Дрейф облака — 18 px по горизонтали за тот же цикл, чтобы перелив был
 * заметен глазу, но не спорил с интерфейсом.
 */
const NEBULA_BREATH_SEC = 20;
const NEBULA_OPACITY_MIN = 0.15;
const NEBULA_OPACITY_MAX = 0.45;
const NEBULA_DRIFT_PX = 18;

/** Живое небо оживает только там, где пользователь не просил меньше движения. */
const COSMOS_MEDIA = "(prefers-reduced-motion: no-preference)";

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Округление до десятых: координаты пути остаются короткими и стабильными. */
function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Хэш-шум на целочисленной арифметике — на нём стоит вся статичная разметка
 * звёздного поля и искр сверхновой.
 *
 * `Math.sin` / `Math.exp` не обязаны быть корректно округлёнными: Node (SSR) и
 * Chrome (гидратация) вправе вернуть разные последние биты, и тогда сервер и
 * клиент строят РАЗНЫЕ звёздные поля — именно это React и называет Hydration
 * Mismatch. `Math.imul` и побитовые сдвиги определены побитово, поэтому зерно
 * даёт в точности одно и то же число в любой среде, а `.toFixed(3)` фиксирует
 * строку в атрибутах.
 */
function hashNoise(seed: number): number {
  let value = Math.imul(Math.floor(seed * 1000) | 0, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 15), 0x27d4eb2d);
  value = (value ^ (value >>> 15)) >>> 0;

  return value / 4294967296;
}

/** Осколок сверхновой: вектор разлёта (px) и радиус искры (1–2 px). */
interface SparkShard {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/**
 * Детерминированная россыпь осколков: 12–16 искр равномерно по кругу со
 * случайным, но стабильным разлётом. Радиус разлёта начинается за пределами
 * золотого гиганта (~38 px в диаметре), поэтому искры вылетают из-под диска
 * звезды, а не тонут в её свечении. Разметка одинакова на сервере и клиенте
 * (гидратация не расходится), а оживляет искры GSAP.
 */
function buildSparkShards(): readonly SparkShard[] {
  return Array.from({ length: SUPERNOVA_SPARK_COUNT }, (_, index) => {
    const angle = (index / SUPERNOVA_SPARK_COUNT) * Math.PI * 2 + hashNoise(index + 5) * 0.6;
    const distance = 16 + hashNoise(index + 23) * 24;

    return {
      x: Number((Math.cos(angle) * distance).toFixed(1)),
      y: Number((Math.sin(angle) * distance).toFixed(1)),
      /* Радиус искры 0.5–1 px → диаметр 1–2 px, как в спецификации. */
      r: Number((0.5 + hashNoise(index + 41) * 0.5).toFixed(2)),
    };
  });
}

const SUPERNOVA_SPARKS: readonly SparkShard[] = buildSparkShards();

/**
 * Галактические скопления: широкие эллипсы плотности, разбросанные по всей
 * высоте viewBox — включая самую верхнюю кромку окна. Поле сознательно не
 * повторяет орбиту: звёзды живут самостоятельными сгустками, а не «по линейкам»
 * вдоль дуги горизонта.
 */
const STAR_CLUSTERS: readonly DensityBlob[] = [
  { cx: 96, cy: 54, rx: 150, ry: 96, weight: 0.46 },
  { cx: 384, cy: 118, rx: 118, ry: 78, weight: 0.3 },
  { cx: 648, cy: 40, rx: 168, ry: 84, weight: 0.56 },
  { cx: 902, cy: 176, rx: 132, ry: 92, weight: 0.34 },
  { cx: 1168, cy: 62, rx: 156, ry: 88, weight: 0.5 },
  { cx: 1360, cy: 164, rx: 116, ry: 76, weight: 0.32 },
  { cx: 796, cy: 306, rx: 186, ry: 96, weight: 0.26 },
  { cx: 252, cy: 262, rx: 128, ry: 74, weight: 0.2 },
  { cx: 1076, cy: 348, rx: 158, ry: 82, weight: 0.22 },
  { cx: 528, cy: 386, rx: 138, ry: 62, weight: 0.16 },
  { cx: 1338, cy: 402, rx: 122, ry: 60, weight: 0.14 },
  { cx: 60, cy: 372, rx: 138, ry: 66, weight: 0.14 },
];

/**
 * Тёмные космические пустоты: вычитаются из плотности. Именно они разбивают
 * поле на скопления и провалы — без них звёзды легли бы ровной «скатертью».
 */
const STAR_VOIDS: readonly DensityBlob[] = [
  { cx: 262, cy: 96, rx: 118, ry: 76, weight: 0.94 },
  { cx: 546, cy: 210, rx: 140, ry: 86, weight: 0.9 },
  { cx: 1046, cy: 132, rx: 126, ry: 82, weight: 0.88 },
  { cx: 1250, cy: 288, rx: 148, ry: 84, weight: 0.92 },
  { cx: 690, cy: 372, rx: 152, ry: 70, weight: 0.86 },
  { cx: 128, cy: 206, rx: 122, ry: 74, weight: 0.82 },
];

/** Шаг сетки-кандидата: мелкая пыль 1 px, джиттер внутри ячейки прячет сетку. */
const STAR_GRID_STEP_X = 13;
const STAR_GRID_STEP_Y = 11;

/** Сдвиг генератора: поле стабильно между SSR и гидратацией (никаких Math.random). */
const STAR_FIELD_SEED = 11.3;

/** Плотность поля в точке: редкий фон + скопления − пустоты. */
function starDensity(x: number, y: number): number {
  let density = 0.055;

  for (const cluster of STAR_CLUSTERS) {
    const dx = (x - cluster.cx) / cluster.rx;
    const dy = (y - cluster.cy) / cluster.ry;
    density += cluster.weight * Math.exp(-(dx * dx + dy * dy));
  }

  for (const voidBlob of STAR_VOIDS) {
    const dx = (x - voidBlob.cx) / voidBlob.rx;
    const dy = (y - voidBlob.cy) / voidBlob.ry;
    density *= 1 - voidBlob.weight * Math.exp(-(dx * dx + dy * dy));
  }

  return density;
}

/**
 * Органичное звёздное поле вместо звёзд «по контуру орбиты».
 *
 * Кандидаты идут по сетке с джиттером внутри ячейки, а решение «ставить звезду
 * или нет» принимает плотность (`starDensity`) с шумовым зерном. Внутри
 * скоплений поле превращается в плотную пыль 0.5–0.85 px, в пустотах остаются
 * редкие одиночные звёзды 2 px — экран читается как настоящая галактика с
 * провалами. Поле накрывает всю высоту viewBox (0–440 px), поэтому над линией
 * горизонта нет пустой чёрной полосы вплоть до верхнего края окна.
 */
function buildStarField(): readonly StarDot[] {
  const stars: StarDot[] = [];
  const columns = Math.ceil(VIEW_WIDTH / STAR_GRID_STEP_X);
  const rows = Math.ceil(VIEW_HEIGHT / STAR_GRID_STEP_Y);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const seed = row * columns + column + STAR_FIELD_SEED;
      const x = (column + 0.1 + hashNoise(seed + 3) * 0.8) * STAR_GRID_STEP_X;
      const y = (row + 0.1 + hashNoise(seed + 11) * 0.8) * STAR_GRID_STEP_Y;
      /* Зерно шума рвёт гладкие гауссовы пятна на живые сгустки и просветы. */
      const grain = 0.5 + 0.95 * hashNoise(seed * 0.73 + 29);

      /*
       * Порог плотности квантуется до 1e−6: `Math.exp` внутри `starDensity`
       * тоже не обязан совпадать до последнего бита между средами, а сравнение
       * уже округлённых величин принимает одинаковое решение на сервере и
       * клиенте — набор звёзд не «переезжает» при гидратации.
       */
      const threshold = Math.round(starDensity(x, y) * grain * 1e6) / 1e6;

      if (hashNoise(seed + 47) > threshold) {
        continue;
      }

      const sparkle = hashNoise(seed + 131);
      const bright = hashNoise(seed + 83) > 0.955;
      /* Пыль — 1 px, редкая одиночная звезда — 2 px плюс мягкий ореол. */
      const radius = bright ? 1.05 + sparkle * 0.35 : 0.55 + sparkle * 0.38;
      const opacity = bright ? 0.62 + sparkle * 0.28 : 0.26 + sparkle * 0.36;

      /*
       * Все атрибуты — фиксированные строки с тремя знаками: SSR и клиент
       * сериализуют разметку байт в байт, Hydration Mismatch невозможен.
       */
      stars.push({
        cx: x.toFixed(3),
        cy: y.toFixed(3),
        r: radius.toFixed(3),
        opacity: opacity.toFixed(3),
        bright,
      });
    }
  }

  return stars;
}

/**
 * Звёздное поле: два слоя — мелкая пыль толщиной 1 px и редкие одиночные звёзды
 * 2 px с мягким ореолом. Радиальные градиенты дают звёздам светящийся профиль
 * без SVG-фильтров, поэтому слой остаётся дешёвым для композитора.
 */
function StarField(): ReactElement {
  const stars = buildStarField();
  const dust = stars.filter((star) => !star.bright);
  const bright = stars.filter((star) => star.bright);

  return (
    <g>
      <g fill="url(#galaxy-star-dust)">
        {dust.map((star, index) => (
          <circle
            key={`galaxy-dust-${index}`}
            cx={star.cx}
            cy={star.cy}
            r={star.r}
            opacity={star.opacity}
          />
        ))}
      </g>
      <g fill="url(#galaxy-star-bright)">
        {bright.map((star, index) => (
          <circle
            key={`galaxy-bright-${index}`}
            cx={star.cx}
            cy={star.cy}
            r={star.r}
            opacity={star.opacity}
          />
        ))}
      </g>
    </g>
  );
}

/**
 * Звёзды-пульсары (цефеиды): семь ярких точек в разных зонах неба, включая
 * область над горизонтом. Пульсацию (асинхронные периоды 4–9 s) задаёт GSAP,
 * поэтому в разметке — только исходная прозрачность и профили свечения.
 */
function PulsarField(): ReactElement {
  return (
    <g>
      {COSMOS_PULSARS.map((star, index) => (
        <g key={`cosmos-pulsar-${index}`} className="cosmos-pulsar" opacity={0.85}>
          <circle
            cx={star.cx}
            cy={star.cy}
            r={star.r * 3.4}
            fill="url(#cosmos-pulsar-halo)"
            opacity={0.32}
          />
          <circle cx={star.cx} cy={star.cy} r={star.r} fill="url(#cosmos-pulsar-core)" />
        </g>
      ))}
    </g>
  );
}

/**
 * «Столпы Творения» — процедурная миниатюра дальнего плана: три плотные
 * газопылевые колонны, растущие из общей туманности.
 *
 * Композиция висит в правой части неба (`translate(1042 34)`): ниже и правее
 * центра и на 12 px выше правой дуги горизонта, левее статус-бейджа шапки.
 * Столпы парят в глубоком космосе, а не «стоят» на горизонте как горы. Габарит
 * силуэта — `≈ 48 × 44 px` в координатах viewBox: миниатюру замечают, когда
 * смотрят на небо, и она не спорит с интерфейсом.
 *
 * Геометрия повторяет классический снимок Хаббла, а не «три сосульки»:
 * 1. левый столп — самый высокий и массивный: клубящаяся колонна с округлой
 *    «шапкой» и заметным округлым выступом справа;
 * 2. средний — на треть ниже, тоньше и бледнее: читается вторым планом;
 * 3. правый — самый короткий, с широким распластанным основанием.
 * Все три чуть наклонены вправо: вершина каждого смещена вправо от центра
 * основания, а «шапки» мягко загнуты в ту же сторону.
 *
 * Живопись — только SVG, без растра. Плотная пылевая масса — глубокий индиго
 * (`#312E81` → `#1E293B`), к низу градиент тела уходит в полную прозрачность.
 * Поверх всех слоёв лежит вертикальная маска-градиент (`y = 0…46`), которая
 * гасит непрозрачность от `0.65` вверху до `0` внизу: основание всех трёх
 * столпов тает в прозрачности, ровного горизонтального среза у подножия нет.
 * Размытые копии силуэтов дают мягкую газовую корону по краям, клипованные
 * сгустки-«клубни» — неровную фактуру внутри, а по верхним округлым вершинам
 * идёт тёплая золотисто-янтарная кайма (`#FBBF24` / `#F59E0B`), нарисованная
 * только размытыми слоями (`feGaussianBlur` 2.5–3): жёсткой линии обводки,
 * из-за которой силуэт читался как «скалы в жёлтой рамке», больше нет.
 * Слой статичен: это дальний план, он не участвует в «живом космосе» и не
 * тратит кадры на анимацию.
 */
function PillarsOfCreation(): ReactElement {
  /*
   * Силуэты «Столпов Творения» в локальных координатах композиции (`≈ 0 0 48 46`).
   *
   * Каждый столп — замкнутый неровный контур: обе кромки поднимаются из общего
   * облака основания, «клубятся» по высоте (мелкие волны Безье) и заканчиваются
   * округлой «шапкой», загнутой вправо. Наклон вправо задан смещением вершины от
   * центра основания. Высоты убывают слева направо: ~42 → 33 → 25 px, толщина
   * тоже, поэтому три колонны не складываются в симметричную «букву Ш».
   * Замыкающая линия проходит по `y ≈ 45` — там вертикальный градиент тела уже
   * полностью прозрачен: прямого среза снизу нет, колонны растворяются в пыли.
   */
  const leftPillar =
    "M2.4 44.6 C1.2 40.8 2.2 37.2 1.8 33.4 C1.4 29.4 2.3 25.4 2 21.4 " +
    "C1.8 17.8 2.6 14.2 3.4 10.8 C4 8 4.8 5.4 6.7 3.6 " +
    "C8 2.5 9.5 2.6 10.5 3.8 C11.4 4.9 11.8 6.3 11.4 7.8 " +
    "C12.7 8.3 13.6 9.5 13.7 11.1 C13.9 13.3 12.9 14.8 13 16.6 " +
    "C13.1 19 14.1 21.2 13.6 23.6 C13.1 26.1 14.2 28.6 15.3 31 " +
    "C16.6 33.8 18.1 36.6 19.7 39.4 C20.6 41 21.2 42.6 21.7 44.8 Z";
  const middlePillar =
    "M26.2 44.9 C25.3 41.3 26.4 37.9 26 34.3 C25.6 31 26.6 27.9 26.4 24.8 " +
    "C26.3 21.9 27 19.3 27.9 16.7 C28.5 15 29.3 13.6 30.5 12.6 " +
    "C31.6 11.8 32.8 12 33.6 12.9 C34.3 13.8 34.4 15.1 34 16.2 " +
    "C35 16.7 35.7 17.6 35.8 18.8 C36 20.7 35.2 22.1 35.4 23.8 " +
    "C35.6 26.1 36.5 28.4 36.1 30.8 C35.7 33.3 36.8 35.7 37.6 38.1 " +
    "C38.4 40.2 38.9 42.4 39.2 45 Z";
  const rightPillar =
    "M35.9 45.1 C35.2 42.3 36.1 39.9 35.9 37.3 C35.7 34.7 36.5 32.3 36.4 29.7 " +
    "C36.3 27.5 37 25.7 37.8 23.9 C38.4 22.5 39.2 21.3 40.3 20.6 " +
    "C41.2 20 42.2 20.3 42.8 21.1 C43.3 21.9 43.3 23 43 23.9 " +
    "C43.7 24.5 44.2 25.4 44.2 26.5 C44.2 28.1 43.5 29.3 43.6 30.7 " +
    "C43.8 32.7 44.7 34.7 45.4 36.9 C46.1 39.3 46.9 41.7 47.6 44.1 " +
    "C47.9 45 48.1 45.5 48.3 45.9 Z";

  /*
   * Золотисто-янтарная кайма подсветки: те же верхние «шапки», что и в контурах,
   * но отдельными разомкнутыми дугами. Рисуется только свечением — два слоя
   * разной ширины, и оба размыты `feGaussianBlur` (3 и 2.5), поэтому жёсткой
   * линии обводки нет: тёплый свет «просачивается» сквозь пыль.
   */
  const leftRim =
    "M2.9 11.6 C3.5 8.4 4.4 5.6 6.7 3.6 C8 2.5 9.5 2.6 10.5 3.8 " +
    "C11.4 4.9 11.8 6.3 11.4 7.8 C12.7 8.3 13.6 9.5 13.7 11.1";
  const middleRim =
    "M27.7 17.6 C28.3 15.7 29.1 14.1 30.5 12.6 C31.6 11.8 32.8 12 33.6 12.9 " +
    "C34.3 13.8 34.4 15.1 34 16.2 C35 16.7 35.7 17.6 35.8 18.8";
  const rightRim =
    "M38.1 23.9 C38.7 22.4 39.4 21.3 40.3 20.6 C41.2 20 42.2 20.3 42.8 21.1 " +
    "C43.3 21.9 43.3 23 43 23.9 C43.7 24.5 44.2 25.4 44.2 26.5";

  return (
    <g className="cosmos-pillars" transform="translate(1042 34)" opacity={0.9}>
      <defs>
        {/*
         * Тело колонны в координатах композиции (`userSpaceOnUse`, `y = 0…46`):
         * тёплый подсвеченный верх → глубокий индиго `#312E81` → тёмный
         * сине-серый `#1E293B` → полная прозрачность к основанию. Последние два
         * стопа и есть «растворение в темноте»: прямого среза снизу не видно ни
         * при каком масштабе, колонны сливаются в пылевое облако.
         */}
        <linearGradient
          id="cosmos-pillars-body"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="46"
        >
          <stop offset="0%" stopColor="#4C46A0" stopOpacity={0.7} />
          <stop offset="12%" stopColor="#3B3890" stopOpacity={0.8} />
          <stop offset="30%" stopColor="#312E81" stopOpacity={0.82} />
          <stop offset="50%" stopColor="#262C5E" stopOpacity={0.76} />
          <stop offset="66%" stopColor="#1E293B" stopOpacity={0.62} />
          <stop offset="82%" stopColor="#182234" stopOpacity={0.36} />
          <stop offset="93%" stopColor="#111B28" stopOpacity={0.14} />
          <stop offset="100%" stopColor="#0C1420" stopOpacity={0} />
        </linearGradient>
        {/* Корона: холодное свечение газа, которое читается по кромкам колонн */}
        <linearGradient
          id="cosmos-pillars-corona-fill"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="46"
        >
          <stop offset="0%" stopColor="#CFE0FF" stopOpacity={0.28} />
          <stop offset="30%" stopColor="#93A8E8" stopOpacity={0.2} />
          <stop offset="62%" stopColor="#4A5E9C" stopOpacity={0.1} />
          <stop offset="100%" stopColor="#16233F" stopOpacity={0} />
        </linearGradient>
        {/* Дальняя газовая вуаль вокруг всей композиции */}
        <radialGradient id="cosmos-pillars-haze" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#5C6E9E" stopOpacity={0.18} />
          <stop offset="58%" stopColor="#33415E" stopOpacity={0.08} />
          <stop offset="100%" stopColor="#1E2A4A" stopOpacity={0} />
        </radialGradient>
        {/* Основание: широкое полупрозрачное облако, тающее к краям */}
        <radialGradient id="cosmos-pillars-base" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6E82B8" stopOpacity={0.34} />
          <stop offset="40%" stopColor="#33456F" stopOpacity={0.18} />
          <stop offset="72%" stopColor="#1C2A4A" stopOpacity={0.07} />
          <stop offset="100%" stopColor="#131F33" stopOpacity={0} />
        </radialGradient>
        {/* Пылевая дорожка у подножия: тёплый ледяной отсвет на срезе облака */}
        <radialGradient id="cosmos-pillars-dust" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#A8BCFF" stopOpacity={0.24} />
          <stop offset="55%" stopColor="#5870B4" stopOpacity={0.1} />
          <stop offset="100%" stopColor="#1E2A4A" stopOpacity={0} />
        </radialGradient>
        {/* Клубящиеся сгустки пыли внутри силуэтов: плотная, неровная фактура */}
        <radialGradient id="cosmos-pillars-clump" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#1E293B" stopOpacity={0.55} />
          <stop offset="55%" stopColor="#1A2340" stopOpacity={0.26} />
          <stop offset="100%" stopColor="#111C2F" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="cosmos-pillars-clump-lit" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#4C51A8" stopOpacity={0.32} />
          <stop offset="55%" stopColor="#3A3D85" stopOpacity={0.16} />
          <stop offset="100%" stopColor="#2A2A5E" stopOpacity={0} />
        </radialGradient>
        {/* Клип по объединению трёх контуров: фактура не вылезает за кромки */}
        <clipPath id="cosmos-pillars-clip">
          <path d={leftPillar} />
          <path d={middlePillar} />
          <path d={rightPillar} />
        </clipPath>
        <filter id="cosmos-pillars-soft" x="-45%" y="-35%" width="190%" height="180%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
        <filter id="cosmos-pillars-corona" x="-60%" y="-35%" width="220%" height="180%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id="cosmos-pillars-base-blur" x="-50%" y="-80%" width="200%" height="260%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
        <filter id="cosmos-pillars-rim-glow" x="-90%" y="-90%" width="280%" height="280%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id="cosmos-pillars-rim-soft" x="-90%" y="-90%" width="280%" height="280%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <filter id="cosmos-pillars-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        {/*
         * Маска растворения основания. Вертикаль композиции (`y = 0…46`):
         * непрозрачность падает от `0.65` на макушках до `0` у подножия,
         * поэтому тела, кромочные штрихи и облако основания тают в прозрачности
         * без ровного горизонтального среза.
         */}
        <linearGradient
          id="cosmos-pillars-fade"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="46"
        >
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.65} />
          <stop offset="45%" stopColor="#FFFFFF" stopOpacity={0.6} />
          <stop offset="68%" stopColor="#FFFFFF" stopOpacity={0.36} />
          <stop offset="86%" stopColor="#FFFFFF" stopOpacity={0.1} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
        </linearGradient>
        <mask
          id="cosmos-pillars-fade-mask"
          maskUnits="userSpaceOnUse"
          x="-10"
          y="-8"
          width="68"
          height="62"
        >
          <rect x="-10" y="-8" width="68" height="62" fill="url(#cosmos-pillars-fade)" />
        </mask>
      </defs>

      {/* 1. Дальняя газовая вуаль: пространство, в котором «висят» колонны */}
      <ellipse cx={23} cy={20} rx={26} ry={22} fill="url(#cosmos-pillars-haze)" />

      {/*
       * 2. Газовая корона: размытые копии тех же силуэтов. `feGaussianBlur`
       * расползается за кромки, но тела колонн рисуются поверх и закрывают
       * середину — светятся ровно края, поэтому пыль читается объёмной, а не
       * вырезанной из бумаги.
       *
       * Вся группа столпов лежит под маской `cosmos-pillars-fade-mask`:
       * основание (тела, кромочные штрихи, облако пыли и кайма) гаснет в
       * прозрачности, поэтому у подножия нет ровного горизонтального среза.
       */}
      <g mask="url(#cosmos-pillars-fade-mask)">
        <g
          filter="url(#cosmos-pillars-corona)"
          opacity={0.85}
          fill="url(#cosmos-pillars-corona-fill)"
        >
          <path d={middlePillar} />
          <path d={rightPillar} />
          <path d={leftPillar} />
        </g>

        {/*
         * 3. Единое газопылевое основание: три сгустка и общее широкое облако.
         * Радиальные градиенты кончаются нулём, поэтому облако плавно растворяется
         * в темноте космоса — резкого прямого среза под столпами нет.
         */}
        <g filter="url(#cosmos-pillars-base-blur)">
          <ellipse cx={24} cy={40.5} rx={26} ry={8.5} fill="url(#cosmos-pillars-base)" />
          <ellipse cx={11} cy={38.5} rx={12.5} ry={6} fill="url(#cosmos-pillars-base)" />
          <ellipse cx={39} cy={40.5} rx={12} ry={6.5} fill="url(#cosmos-pillars-base)" opacity={0.9} />
          <ellipse cx={24} cy={41.5} rx={22} ry={4.8} fill="url(#cosmos-pillars-dust)" />
        </g>

        {/*
         * 4. Тела колонн. Порядок слоёв задаёт глубину: средний и правый столпы —
         * дальний план (бледнее, правый самый низкий и распластанный), левый —
         * передний, самый плотный, массивный и высокий.
         */}
        <g filter="url(#cosmos-pillars-soft)">
          <path d={middlePillar} fill="url(#cosmos-pillars-body)" opacity={0.86} />
          <path d={rightPillar} fill="url(#cosmos-pillars-body)" opacity={0.74} />
          <path d={leftPillar} fill="url(#cosmos-pillars-body)" />

          {/*
           * Фактура: размытые сгустки пыли внутри силуэтов. Клип по объединению трёх
           * контуров не даёт «клубням» вылезти за кромки, поэтому масса выглядит
           * плотной и неровной, а не плоской заливкой.
           */}
          <g clipPath="url(#cosmos-pillars-clip)">
            <ellipse cx={7.6} cy={13} rx={6.2} ry={5.4} fill="url(#cosmos-pillars-clump)" />
            <ellipse cx={4.6} cy={22.4} rx={4.8} ry={7.2} fill="url(#cosmos-pillars-clump)" />
            <ellipse
              cx={10.8}
              cy={20.6}
              rx={4.4}
              ry={5.6}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.8}
            />
            <ellipse
              cx={8.4}
              cy={31.4}
              rx={6}
              ry={7}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.85}
            />
            <ellipse
              cx={13.6}
              cy={16.2}
              rx={3.2}
              ry={4.8}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.7}
            />
            <ellipse cx={4.2} cy={16.4} rx={2.2} ry={6.4} fill="url(#cosmos-pillars-clump-lit)" />
            <ellipse
              cx={4.4}
              cy={30.6}
              rx={2.6}
              ry={6.2}
              fill="url(#cosmos-pillars-clump-lit)"
              opacity={0.75}
            />

            <ellipse cx={29.4} cy={22.6} rx={3.8} ry={7.4} fill="url(#cosmos-pillars-clump)" />
            <ellipse
              cx={33}
              cy={31}
              rx={4}
              ry={6.4}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.9}
            />
            <ellipse
              cx={27.6}
              cy={33.4}
              rx={3}
              ry={7}
              fill="url(#cosmos-pillars-clump-lit)"
              opacity={0.7}
            />
            <ellipse
              cx={31}
              cy={15.8}
              rx={3.2}
              ry={2.8}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.85}
            />

            <ellipse cx={39.6} cy={30.4} rx={3.6} ry={6.6} fill="url(#cosmos-pillars-clump)" />
            <ellipse
              cx={43.4}
              cy={35.2}
              rx={3.8}
              ry={6.2}
              fill="url(#cosmos-pillars-clump)"
              opacity={0.9}
            />
            <ellipse
              cx={37.6}
              cy={34.4}
              rx={2.6}
              ry={6}
              fill="url(#cosmos-pillars-clump-lit)"
              opacity={0.6}
            />
          </g>

          {/* Тени по правым кромкам: круглая, а не плоская, форма колонн */}
          <path
            d="M13.8 12 C13.9 14.2 12.9 15.2 13 17 C13.1 19.4 14.1 21.4 13.6 23.8 C13.1 26.2 14.2 28.7 15.3 31.2 C16.6 34 18.1 36.8 19.7 39.6"
            stroke="#04090F"
            strokeOpacity={0.45}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
          <path
            d="M33.9 16.6 C34.1 18.9 35 21.3 34.8 23.6 C35 26 36 28.3 35.6 30.8 C35.2 33.3 36.4 35.7 37.3 38.2"
            stroke="#04090F"
            strokeOpacity={0.38}
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <path
            d="M44.1 24 C44.8 24.6 45.3 25.5 45.3 26.6 C45.3 28.2 44.6 29.4 44.7 30.8 C44.9 32.8 45.7 34.8 45.5 37 C45.3 39.4 46.2 41.7 47 44.2"
            stroke="#04090F"
            strokeOpacity={0.3}
            strokeWidth={1.2}
            strokeLinecap="round"
          />

          {/* Свет по левым кромкам: пыль подсвечена снаружи, кромка «дышит» */}
          <path
            d="M3.4 10.8 C2.7 14.2 2.1 17.8 2.3 21.4 C2.5 25.4 1.4 29.4 1.8 33.4 C2.2 37.2 1.2 40.8 2.4 44.4"
            stroke="#CFDCFF"
            strokeOpacity={0.24}
            strokeWidth={0.7}
            strokeLinecap="round"
          />
          <path
            d="M27.8 17 C26.9 19.4 26.3 21.9 26.4 24.8 C26.6 27.9 25.6 31 26 34.3 C26.4 37.9 25.3 41.3 26.2 44.7"
            stroke="#CFDCFF"
            strokeOpacity={0.17}
            strokeWidth={0.6}
            strokeLinecap="round"
          />
          <path
            d="M37.9 24.2 C37.2 25.8 36.6 27.6 36.7 29.7 C36.8 32.3 36 34.7 36.2 37.3 C36.4 39.9 35.5 42.3 36.1 45"
            stroke="#CFDCFF"
            strokeOpacity={0.13}
            strokeWidth={0.5}
            strokeLinecap="round"
          />
        </g>

        {/*
         * 5. Тёплая золотисто-янтарная кайма по округлым вершинам — только свечение.
         * Два слоя одной и той же дуги, и оба размыты `feGaussianBlur` (3 и 2.5):
         * широкий `#F59E0B` даёт ореол, узкий `#FCD34D` — чуть более плотное тепло
         * у самой кромки. Резкой жёлтой линии обводки нет, поэтому силуэт больше не
         * читается как «скалы в жёлтой рамке», а свет словно просачивается сквозь пыль.
         */}
        <g fill="none" strokeLinecap="round">
          <g
            filter="url(#cosmos-pillars-rim-glow)"
            stroke="#F59E0B"
            strokeOpacity={0.5}
            strokeWidth={2.6}
            opacity={0.7}
          >
            <path d={leftRim} />
            <path d={middleRim} />
            <path d={rightRim} />
          </g>
          <g
            filter="url(#cosmos-pillars-rim-soft)"
            stroke="#FCD34D"
            strokeOpacity={0.45}
            strokeWidth={1.3}
          >
            <path d={leftRim} />
            <path d={middleRim} />
            <path d={rightRim} />
          </g>
        </g>
      </g>

      {/* Тёплые искры на макушках: единственный тёплый акцент сцены */}
      <g filter="url(#cosmos-pillars-glow)" opacity={0.8}>
        <ellipse cx={7.4} cy={3.6} rx={1.4} ry={1} fill="#FBBF24" />
        <ellipse cx={12.2} cy={9.3} rx={1} ry={0.8} fill="#F59E0B" opacity={0.8} />
        <ellipse cx={31.2} cy={13.2} rx={1.1} ry={0.85} fill="#FCD34D" />
        <ellipse cx={41.1} cy={21.2} rx={0.9} ry={0.7} fill="#F59E0B" opacity={0.75} />
        <circle cx={13.4} cy={16.8} r={0.5} fill="#FDE68A" opacity={0.55} />
        <circle cx={33.9} cy={23.6} r={0.45} fill="#FDE68A" opacity={0.45} />
        <circle cx={44.1} cy={30.9} r={0.4} fill="#FDBA74" opacity={0.4} />
      </g>
    </g>
  );
}

/**
 * Далёкая комета: ледяное ядро 1.5–2 px и тонкий растворяющийся хвост ~52 px.
 * Живёт в верхней зоне неба и появляется в противовес кораблю — раз в 45–70 s
 * медленно проходит по пологой касательной за 16–22 s, заполняя паузы между
 * пролётами Trimaxion.
 */
function DistantComet(): ReactElement {
  return (
    <g className="cosmos-comet">
      <g className="cosmos-comet__body">
        <ellipse
          className="cosmos-comet__tail"
          cx={-27}
          cy={0}
          rx={26}
          ry={1}
          fill="url(#cosmos-comet-tail)"
        />
        <circle r={0.95} fill="url(#cosmos-comet-core)" />
      </g>
    </g>
  );
}

/**
 * Редкая сверхновая: звезда медленно разгорается до раскалённого жёлто-золотого
 * гиганта (~36–40 px в диаметре), мягко вспыхивает и распадается на 12–16
 * искр-осколков. Первые доли секунды осколки остаются золотыми, затем остывают
 * до белого и гаснут в темноте. Радиусы, цвет и разлёт задаёт GSAP; здесь —
 * только исходное невидимое состояние (см. `.cosmos-supernova*` в globals.css).
 */
function Supernova(): ReactElement {
  return (
    <g className="cosmos-supernova">
      <circle className="cosmos-supernova__glow" r={0} fill="url(#cosmos-supernova-glow)" opacity={0} />
      <circle className="cosmos-supernova__flash" r={0} fill="url(#cosmos-supernova-flash)" opacity={0} />
      <circle className="cosmos-supernova__core" r={0} fill="#F59E0B" opacity={0} />
      {SUPERNOVA_SPARKS.map((shard, index) => (
        <circle
          key={`cosmos-spark-${index}`}
          className="cosmos-supernova__spark"
          r={shard.r}
          fill="#FACC15"
          opacity={0}
        />
      ))}
    </g>
  );
}

/** Один шлейф: мягкая дымка по форме овала и светящаяся нить горизонта. */
function EllipticalTrail({ trail }: { readonly trail: EllipticalTrailOptions }): ReactElement {
  return (
    <g opacity={trail.opacity}>
      <defs>
        <radialGradient id={`${trail.id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8fa6ff" stopOpacity={0.16} />
          <stop offset="46%" stopColor="#6274d2" stopOpacity={0.075} />
          <stop offset="100%" stopColor="#37457f" stopOpacity={0} />
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
         * Небо горизонта: свечение идёт по самой орбите, а не ровной полосой.
         * Пик лежит чуть выше нижней дуги, а к кромке эллипса яркость плавно
         * сходит в ноль — поэтому верхняя граница свечения читается как мягкая
         * затухающая эллиптическая дуга, без прямой горизонтальной «линейки».
         */}
        <radialGradient
          id={`${trail.id}-sky`}
          gradientUnits="userSpaceOnUse"
          cx={trail.cx}
          cy={trail.cy}
          r={trail.rx}
          gradientTransform={`translate(${trail.cx} ${trail.cy}) scale(1 ${
            trail.ry / trail.rx
          }) translate(${-trail.cx} ${-trail.cy})`}
        >
          <stop offset="0%" stopColor="#6f86d8" stopOpacity={0} />
          <stop offset="55%" stopColor="#7f97ee" stopOpacity={0.02} />
          <stop offset="78%" stopColor="#8ea6ff" stopOpacity={0.045} />
          <stop offset="92%" stopColor="#a7bbff" stopOpacity={0.055} />
          <stop offset="97%" stopColor="#c2d4ff" stopOpacity={0.03} />
          <stop offset="100%" stopColor="#c2d4ff" stopOpacity={0} />
        </radialGradient>
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
        {/*
         * Ядро ближней дуги: свечение собрано в центральной трети экрана.
         * За пределами «бусины» прозрачность падает до нуля, поэтому нить
         * остаётся тонкой и плавно утончается к левому и правому краям окна.
         */}
        <linearGradient
          id={`${trail.id}-bead`}
          gradientUnits="userSpaceOnUse"
          x1={trail.cx - HORIZON_CORE_REACH}
          y1={0}
          x2={trail.cx + HORIZON_CORE_REACH}
          y2={0}
        >
          <stop offset="0%" stopColor="#a9bcec" stopOpacity={0} />
          <stop offset="10%" stopColor="#b6c8f2" stopOpacity={0.16} />
          <stop offset="32%" stopColor="#d3dff8" stopOpacity={0.5} />
          <stop offset="50%" stopColor="#e8f0ff" stopOpacity={0.72} />
          <stop offset="68%" stopColor="#d3dff8" stopOpacity={0.5} />
          <stop offset="90%" stopColor="#b6c8f2" stopOpacity={0.16} />
          <stop offset="100%" stopColor="#a9bcec" stopOpacity={0} />
        </linearGradient>
        {/* Ледяной слой «дыхания» туманности: прозрачностью управляет GSAP */}
        <linearGradient
          id={`${trail.id}-ice`}
          gradientUnits="userSpaceOnUse"
          x1={trail.cx - HORIZON_REACH}
          y1={0}
          x2={trail.cx + HORIZON_REACH}
          y2={0}
        >
          <stop offset="0%" stopColor="#7dd3fc" stopOpacity={0} />
          <stop offset="30%" stopColor="#a5e4ff" stopOpacity={0.22} />
          <stop offset="50%" stopColor="#e0f2fe" stopOpacity={0.42} />
          <stop offset="70%" stopColor="#a5e4ff" stopOpacity={0.22} />
          <stop offset="100%" stopColor="#7dd3fc" stopOpacity={0} />
        </linearGradient>
        {/* Фиолетовый слой «дыхания»: в противофазе к ледяному */}
        <linearGradient
          id={`${trail.id}-violet`}
          gradientUnits="userSpaceOnUse"
          x1={trail.cx - HORIZON_REACH}
          y1={0}
          x2={trail.cx + HORIZON_REACH}
          y2={0}
        >
          <stop offset="0%" stopColor="#7c3aed" stopOpacity={0} />
          <stop offset="30%" stopColor="#a78bfa" stopOpacity={0.2} />
          <stop offset="50%" stopColor="#c4b5fd" stopOpacity={0.38} />
          <stop offset="70%" stopColor="#a78bfa" stopOpacity={0.2} />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
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

      {/* Дымка шлейфа: размытые полосы вдоль дуги, без «рельсов» и рёбер */}
      <g
        fill="none"
        stroke="#8ea6ff"
        strokeWidth={24}
        opacity={0.08}
        filter={`url(#${trail.id}-soft)`}
      >
        {trail.laneOffsets.map((offset, index) => (
          <path key={`${trail.id}-lane-${index}`} d={horizonArcPath(HORIZON_APEX_Y + offset)} />
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

      {/*
       * Звёзд «по контуру овала» здесь больше нет: поле строится отдельным
       * органичным слоем (StarField) по всей высоте неба, а не вдоль орбиты.
       */}

      {/*
       * Задняя дуга: та же точка схода на обеих кромках кадра, что и у ближней
       * нити, но вершина на 30 px выше. Дуги не пересекаются и на кромках
       * сходятся в одну точку — эллипс замкнут с обеих сторон.
       */}
      <path
        d={FAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={34}
        opacity={0.14}
        filter={`url(#${trail.id}-soft)`}
      />
      {/*
       * Тонкая нить задней дуги: мягкое свечение выше читается как объём, но
       * без собственной светящейся кромки дальняя часть эллипса выглядела
       * размытым пятном. Тонкая линия собирает её в выразительный купол и
       * плавно гаснет к тем же кромкам, где начинается ближняя дуга.
       */}
      <path
        d={FAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={1.2}
        opacity={0.3}
        strokeLinecap="round"
      />
      {/* Ореол горизонта: размытая широкая дуга, повторяющая нить горизонта */}
      <path
        d={NEAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={26}
        opacity={0.16}
        filter={`url(#${trail.id}-soft)`}
      />

      {/* Ближний свет: узкое свечение вокруг нити, держит дугу очерченной */}
      <path
        d={NEAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-rim)`}
        strokeWidth={8}
        opacity={0.36}
        filter={`url(#${trail.id}-glow)`}
      />

      {/* Нить горизонта: тонкая светящаяся дуга, гаснущая к краям окна */}
      <path d={NEAR_HORIZON_PATH} stroke={`url(#${trail.id}-rim)`} strokeWidth={1.8} />

      {/*
       * Ближняя дуга: в центральной трети экрана нить чуть плотнее и ярче —
       * мягкое утолщение с плавным сходом на нет к краям окна.
       */}
      <path
        d={NEAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-bead)`}
        strokeWidth={6.2}
        opacity={0.3}
        filter={`url(#${trail.id}-glow)`}
      />
      <path d={NEAR_HORIZON_PATH} stroke={`url(#${trail.id}-bead)`} strokeWidth={2.4} />

      {/*
       * Живой импульс центральной части ближней дуги.
       *
       * `cosmos-horizon-pulse` — то же мягкое утолщение нити, но с прозрачностью
       * 0: GSAP периодически разгоняет её до `HORIZON_PULSE_PEAK` и мягко
       * возвращает назад, поэтому дуга «дышит» от спокойного состояния к чуть
       * более яркому, не пересвечивая кадр.
       *
       * `cosmos-horizon-spark` — компактная белая точка с ореолом, которая
       * неспешно скользит по центральному сегменту слева направо и
       * растворяется в линии у его правого края (позицию и тайминги задаёт
       * `startHorizonPulse`). В разметке — только исходное невидимое состояние,
       * поэтому без JS и при `prefers-reduced-motion` импульса просто нет.
       */}
      <path
        className="cosmos-horizon-pulse"
        d={NEAR_HORIZON_PATH}
        stroke={`url(#${trail.id}-bead)`}
        strokeWidth={9.6}
        filter={`url(#${trail.id}-glow)`}
      />
      <g className="cosmos-horizon-spark">
        <circle r={5.6} fill="url(#cosmos-horizon-spark-halo)" />
        <circle r={1.35} fill="#FFFFFF" />
      </g>

      {/*
       * Дыхание туманности: ледяной и фиолетовый слои в противофазе. GSAP
       * качает их прозрачность сверхмедленным циклом 25–35 s, поэтому перелив
       * горизонта живёт сам по себе — без привязки к движениям мыши.
       */}
      <g className="cosmos-nebula">
        <path
          className="cosmos-nebula__ice"
          d={NEAR_HORIZON_PATH}
          stroke={`url(#${trail.id}-ice)`}
          strokeWidth={18}
          filter={`url(#${trail.id}-glow)`}
        />
        <path
          className="cosmos-nebula__violet"
          d={NEAR_HORIZON_PATH}
          stroke={`url(#${trail.id}-violet)`}
          strokeWidth={34}
          filter={`url(#${trail.id}-soft)`}
        />
      </g>

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
 * Галактическое ядро: вынесено далеко за верхнюю границу окна, поэтому в кадр
 * попадает только нижняя часть эллипса — мягкая вытянутая дуга горизонта. От
 * этого эллипса берутся только мягкие заливки (небо, гало, отсвет ядра); сами
 * дуги горизонта — замкнутые кривые Безье (`NEAR_HORIZON_PATH` /
 * `FAR_HORIZON_PATH`), у которых края сходятся в одну точку.
 *
 * Инварианты геометрии (проверяются по этим числам, 1 единица viewBox = 1 px):
 * — ядро целиком выше кадра: нижняя кромка `cy + 0.7·ry = -7.8` px < 0, то есть
 *   в кадр попадает только отсвет, а не само ядро;
 * — линия горизонта `cy + ry = 120` px лежит в зазоре между верхней панелью
 *   (заголовок + метаданные, до ~93 px) и заголовком секции, поэтому дуга не
 *   пересекает текст;
 * — вершина дуги `HORIZON_APEX_X / VIEW_WIDTH = 60%` совпадает с центром
 *   контентной колонки (сайдбар 256 px слева), а не геометрическим центром окна;
 * — точки схода обеих дуг лежат на кромках кадра (`0; 53` и `1440; 90.2`) — это
 *   одни и те же координаты у передней и задней дуг, поэтому эллипс замкнут.
 */
const MAIN_TRAIL: EllipticalTrailOptions = {
  id: "galaxy-trail",
  cx: 860,
  cy: -306,
  rx: 1600,
  ry: 426,
  laneOffsets: [0, 22, 58],
  opacity: 0.9,
};

/**
 * Видимое «дыхание» туманности: цикл ~20 s, `sine.inOut`, `yoyo`, `repeat: -1`.
 * Прозрачность двух контр-слоёв качается в противофазе в диапазоне 0.15 ↔ 0.45,
 * поэтому перелив уходит то в холодный ледяной тон, то в фиолетовый, а всё
 * облако мягко дрейфует по горизонтали на 18 px — перелив читается глазом, но
 * остаётся фоновым и не спорит с интерфейсом.
 */
function startNebulaBreath(root: HTMLElement): () => void {
  const cloud = root.querySelector<SVGGElement>(".cosmos-nebula");
  const ice = root.querySelector<SVGPathElement>(".cosmos-nebula__ice");
  const violet = root.querySelector<SVGPathElement>(".cosmos-nebula__violet");
  const tweens: gsap.core.Tween[] = [];

  if (ice !== null) {
    tweens.push(
      gsap.fromTo(
        ice,
        { opacity: NEBULA_OPACITY_MAX },
        {
          opacity: NEBULA_OPACITY_MIN,
          duration: NEBULA_BREATH_SEC,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        },
      ),
    );
  }

  if (violet !== null) {
    tweens.push(
      gsap.fromTo(
        violet,
        { opacity: NEBULA_OPACITY_MIN },
        {
          opacity: NEBULA_OPACITY_MAX,
          duration: NEBULA_BREATH_SEC,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        },
      ),
    );
  }

  if (cloud !== null) {
    tweens.push(
      gsap.fromTo(
        cloud,
        { x: -NEBULA_DRIFT_PX / 2, y: 2.5 },
        {
          x: NEBULA_DRIFT_PX / 2,
          y: -2.5,
          duration: NEBULA_BREATH_SEC,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        },
      ),
    );
  }

  return () => {
    for (const tween of tweens) {
      tween.kill();
    }
  };
}

/** Асинхронная пульсация цефеид: у каждой звезды свой период 4–9 s и фаза. */
function startPulsars(root: HTMLElement): () => void {
  const stars = Array.from(root.querySelectorAll<SVGGElement>(".cosmos-pulsar"));
  const tweens = stars.map((star, index) => {
    const period = COSMOS_PULSARS[index]?.period ?? 6;
    const phase = COSMOS_PULSARS[index]?.phase ?? 0;

    return gsap.fromTo(
      star,
      { opacity: 0.42, scale: 0.82 },
      {
        opacity: 1,
        scale: 1.18,
        duration: period,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
        delay: phase,
      },
    );
  });

  return () => {
    for (const tween of tweens) {
      tween.kill();
    }
  };
}

/**
 * Далёкая комета в противовес кораблю: её длинный период (45–70 s) намеренно
 * расходится с ритмом Trimaxion (пролёт 22–28 s + пауза 10–18 s), поэтому
 * пролёты двух тел не сливаются в один такт: комета плавно проступает в небе
 * между появлениями корабля, и небо не пустует. Летит по пологой касательной
 * 16–22 s, хвост всегда развёрнут назад по вектору движения.
 */
function startDistantComet(root: HTMLElement): () => void {
  const comet = root.querySelector<SVGGElement>(".cosmos-comet");
  const body = root.querySelector<SVGGElement>(".cosmos-comet__body");

  if (comet === null || body === null) {
    return () => {};
  }

  let timer: gsap.core.Tween | null = null;
  let flight: gsap.core.Timeline | null = null;

  /*
   * Флаг остановки: после размонтирования или смены media-условия цепочка
   * «пауза → полёт → пауза» больше не продлевается. Без него `onComplete`
   * последнего таймлайна успевал поставить новый таймер уже после очистки, и
   * комета «зависала» — невидимая, но с живым таймером.
   */
  let stopped = false;

  const schedule = (): void => {
    if (stopped) {
      return;
    }

    timer?.kill();
    timer = gsap.delayedCall(randomBetween(COMET_GAP_MIN_SEC, COMET_GAP_MAX_SEC), launch);
  };

  const launch = (): void => {
    if (stopped) {
      return;
    }

    const leftToRight = Math.random() > 0.5;
    const startX = leftToRight ? -70 : VIEW_WIDTH + 70;
    const endX = leftToRight ? VIEW_WIDTH + 70 : -70;
    const startY = randomBetween(34, 112);
    const endY = startY + randomBetween(-26, 26);
    const travel = randomBetween(COMET_TRAVEL_MIN_SEC, COMET_TRAVEL_MAX_SEC);
    const heading = (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI;

    /* Хвост смотрит назад: при полёте влево тело зеркалится на 180°. */
    gsap.set(body, {
      rotation: leftToRight ? heading : heading + 180,
      scaleX: leftToRight ? 1 : -1,
      transformOrigin: "50% 50%",
    });

    flight?.kill();
    flight = gsap.timeline({
      onComplete: () => {
        flight = null;
        schedule();
      },
    });
    flight
      .fromTo(
        comet,
        { x: startX, y: startY },
        { x: endX, y: endY, duration: travel, ease: "none" },
        0,
      )
      .fromTo(comet, { opacity: 0 }, { opacity: 0.85, duration: travel * 0.24, ease: "sine.out" }, 0)
      .to(comet, { opacity: 0, duration: travel * 0.32, ease: "sine.in" }, travel * 0.68);
  };

  schedule();

  return () => {
    stopped = true;
    timer?.kill();
    timer = null;
    flight?.kill();
    flight = null;
    gsap.set(comet, { opacity: 0 });
  };
}

/**
 * Редкая сверхновая: первый взрыв — через 30–50 s после загрузки страницы, далее
 * раз в 4–5 минут. В случайной точке верхней зоны неба звезда 4–5 s разгорается
 * до раскалённого жёлто-золотого гиганта (~36–40 px: `#FACC15` → `#F59E0B` →
 * `#EA580C`), затем мягко вспыхивает тёплым золотом, и 14 искр-осколков
 * разлетаются в стороны: первые доли секунды они золотые, затем остывают до
 * белого и за 3–4 s полностью гаснут в темноте.
 */
function startSupernova(root: HTMLElement): () => void {
  const host = root.querySelector<SVGGElement>(".cosmos-supernova");
  const glow = root.querySelector<SVGCircleElement>(".cosmos-supernova__glow");
  const core = root.querySelector<SVGCircleElement>(".cosmos-supernova__core");
  const flash = root.querySelector<SVGCircleElement>(".cosmos-supernova__flash");
  const sparks = Array.from(root.querySelectorAll<SVGCircleElement>(".cosmos-supernova__spark"));

  if (host === null || glow === null || core === null || flash === null) {
    return () => {};
  }

  let timer: gsap.core.Tween | null = null;
  let blast: gsap.core.Timeline | null = null;

  /* Остановленный цикл не продлевает себя: см. комментарий в startDistantComet. */
  let stopped = false;

  const reset = (): void => {
    gsap.set(host, { opacity: 0 });
    gsap.set(glow, { attr: { r: 0 }, opacity: 0 });
    gsap.set(core, { attr: { r: 0.6 }, opacity: 0, fill: "#F59E0B" });
    gsap.set(flash, { attr: { r: 1 }, opacity: 0 });
    gsap.set(sparks, { x: 0, y: 0, opacity: 0, attr: { r: 0.8 }, fill: "#FACC15" });
  };

  const ignite = (): void => {
    if (stopped) {
      return;
    }

    reset();
    gsap.set(host, {
      x: randomBetween(220, VIEW_WIDTH - 220),
      y: randomBetween(36, 116),
      opacity: 1,
    });

    blast?.kill();
    blast = gsap.timeline({
      onComplete: () => {
        blast = null;
        reset();
        schedule(false);
      },
    });

    /*
     * 1. Разгорание: точка превращается в раскалённый жёлто-золотой гигант
     *    Ø ~38 px. Центр — плотное золото `#FACC15`, к краю — `#F59E0B` и
     *    `#EA580C`; белого в палитре звезды нет.
     */
    blast.fromTo(
      glow,
      { attr: { r: 0 }, opacity: 0 },
      {
        attr: { r: SUPERNOVA_GLOW_RADIUS },
        opacity: 0.62,
        duration: SUPERNOVA_RISE_SEC,
        ease: "sine.in",
      },
      0,
    );
    blast.fromTo(
      core,
      { attr: { r: 0.6 }, opacity: 0, fill: "#F59E0B" },
      {
        attr: { r: SUPERNOVA_CORE_RADIUS },
        opacity: 1,
        fill: "#FACC15",
        duration: SUPERNOVA_RISE_SEC,
        ease: "sine.in",
      },
      0,
    );
    /* 2. Тёплая золотая вспышка — и звезда гаснет. */
    blast.fromTo(
      flash,
      { attr: { r: 3 }, opacity: 0.9 },
      { attr: { r: 30 }, opacity: 0, duration: 1.35, ease: "sine.out" },
      SUPERNOVA_RISE_SEC,
    );
    blast.to(core, { attr: { r: 0 }, opacity: 0, duration: 1.2, ease: "sine.out" }, SUPERNOVA_RISE_SEC);
    blast.to(glow, { attr: { r: 0 }, opacity: 0, duration: 1.4, ease: "sine.out" }, SUPERNOVA_RISE_SEC);
    /*
     * 3. Осколки: разлетаются из-под диска звезды, первые ~0.7 s остаются
     *    ярко-золотыми, затем остывают до белого и плавно гаснут в темноте.
     */
    blast.fromTo(
      sparks,
      { x: 0, y: 0, opacity: 1, attr: { r: 1 }, fill: "#FACC15" },
      {
        x: (index: number) => SUPERNOVA_SPARKS[index]?.x ?? 0,
        y: (index: number) => SUPERNOVA_SPARKS[index]?.y ?? 0,
        attr: { r: 0.4 },
        duration: 3.8,
        ease: "power2.out",
        stagger: 0.03,
      },
      SUPERNOVA_RISE_SEC + 0.06,
    );
    blast.to(
      sparks,
      { fill: "#FFFFFF", duration: 0.72, ease: "sine.out", stagger: 0.02 },
      SUPERNOVA_RISE_SEC + 0.06,
    );
    blast.to(
      sparks,
      { opacity: 0, duration: 3.1, ease: "sine.in", stagger: 0.03 },
      SUPERNOVA_RISE_SEC + 0.5,
    );
  };

  const schedule = (first: boolean): void => {
    if (stopped) {
      return;
    }

    timer?.kill();
    const delay = first
      ? randomBetween(SUPERNOVA_FIRST_MIN_SEC, SUPERNOVA_FIRST_MAX_SEC)
      : randomBetween(SUPERNOVA_GAP_MIN_SEC, SUPERNOVA_GAP_MAX_SEC);
    timer = gsap.delayedCall(delay, ignite);
  };

  schedule(true);

  return () => {
    stopped = true;
    timer?.kill();
    timer = null;
    blast?.kill();
    blast = null;
    reset();
  };
}

/**
 * Живой импульс горизонта событий: свечение центральной части ближней дуги
 * периодически усиливается, а по самому сегменту неспешно скользит компактная
 * белая точка-искра с мягким ореолом.
 *
 * Оба эффекта живут в одном повторяющемся таймлайне, поэтому усиление дуги и
 * пробег искры синхронны: свечение разгорается, пока искра идёт по линии, и
 * возвращается к спокойному состоянию к тому моменту, когда точка
 * растворяется у правого края сегмента. Дальше — пауза 3–6 s, после чего цикл
 * начинается заново с новой длительностью, чтобы ритм не стал метрономом.
 * Y-координата берётся из `nearHorizonY`, то есть точка всегда лежит на
 * светящейся нити, а не рядом с ней.
 */
function startHorizonPulse(root: HTMLElement): () => void {
  const pulse = root.querySelector<SVGPathElement>(".cosmos-horizon-pulse");
  const spark = root.querySelector<SVGGElement>(".cosmos-horizon-spark");

  if (pulse === null || spark === null) {
    return () => {};
  }

  const fromX = HORIZON_APEX_X - HORIZON_SPARK_REACH;
  const toX = HORIZON_APEX_X + HORIZON_SPARK_REACH;
  const travel = randomBetween(HORIZON_SPARK_TRAVEL_MIN_SEC, HORIZON_SPARK_TRAVEL_MAX_SEC);

  /* Позиция искры — единственный источник правды: Y всегда из параболы дуги. */
  const cursor = { x: fromX };
  const place = (): void => {
    gsap.set(spark, { x: cursor.x, y: nearHorizonY(cursor.x) });
  };

  place();
  gsap.set(spark, { opacity: 0 });
  gsap.set(pulse, { opacity: 0 });

  const timeline = gsap.timeline({
    repeat: -1,
    repeatDelay: randomBetween(HORIZON_SPARK_PAUSE_MIN_SEC, HORIZON_SPARK_PAUSE_MAX_SEC),
  });

  /* Пробег: симметричный разгон и торможение, чтобы искра не «телепортировалась». */
  timeline.fromTo(
    cursor,
    { x: fromX },
    { x: toX, duration: travel, ease: "sine.inOut", onUpdate: place },
    0,
  );
  /* Усиление дуги: разгорается к середине пробега и мягко возвращается назад. */
  timeline.fromTo(
    pulse,
    { opacity: 0 },
    {
      opacity: HORIZON_PULSE_PEAK,
      duration: travel * 0.42,
      ease: "sine.inOut",
      yoyo: true,
      repeat: 1,
    },
    0,
  );
  /* Искра: мягкое появление на входе и растворение в линии у правого края. */
  timeline.fromTo(
    spark,
    { opacity: 0 },
    { opacity: 1, duration: travel * 0.14, ease: "sine.out" },
    0,
  );
  timeline.to(spark, { opacity: 0, duration: travel * 0.22, ease: "sine.in" }, travel * 0.78);

  return () => {
    timeline.kill();
    gsap.set(spark, { opacity: 0 });
    gsap.set(pulse, { opacity: 0 });
  };
}

/**
 * Декоративный фон: эллиптическая орбита галактики (инлайн-SVG) и северное
 * сияние из плавных градиентных лент с очень медленным циклом 26–33 s.
 *
 * Геометрия фона: ядро галактики вынесено далеко за верхнюю границу окна,
 * поэтому в кадр попадает только нижняя дуга орбиты — она читается как
 * «горизонт событий»: мягкая вытянутая светящаяся дуга в центре верхней
 * панели, а задняя дуга вместе с передней замыкают эллипс на кромках кадра.
 * Нижние дорожки плавно спускаются под карточки «Модули». mask-градиент гасит
 * шлейф у левого и правого краёв, а нить горизонта собрана в центре, поэтому
 * заголовок «Обзор» и метаданные лежат на затемнённом участке с сохранённым
 * контрастом.
 *
 * Галактика не статична: кроме корабля-пасхалки в небе живут звёзды-пульсары
 * (`PulsarField`), далёкая комета (`DistantComet`) и редкая сверхновая
 * (`Supernova`), туманность горизонта сверхмедленно «дышит», а по центральному
 * сегменту ближней дуги неспешно бежит белая искра (`startHorizonPulse`). Всё
 * это — GSAP строго внутри `prefers-reduced-motion: no-preference`; при
 * reduced-motion остаётся спокойная статичная картинка.
 *
 * Инварианты контраста (WCAG >= 7:1): слой живёт на уровне canvas
 * (`z-index: -1`), а контент AppShell поднят на `z-index: 10` и лежит на
 * непрозрачных `--color-canvas` / `--color-surface`. Все заливки фона
 * низкоальфные, общая прозрачность слоя ограничена, а `mask-image` гасит фон
 * вниз экрана — светимость под текстом остаётся низкой, поэтому `--color-ink`
 * сохраняет расчётный контраст выше 7:1. При `prefers-reduced-motion`
 * анимации отключаются (правило в globals.css).
 */
export function AuroraBackdrop(): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);

  /*
   * Живой космос — один `matchMedia`-скоуп: всё, что здесь создаётся,
   * автоматически снимается, если пользователь переключился на
   * `prefers-reduced-motion: reduce` (и не создаётся вовсе, если он пришёл с
   * таким запросом). Никакой привязки к мыши: туманность «дышит», цефеиды
   * пульсируют, комета и сверхновая живут по собственным таймерам, а по центру
   * ближней дуги горизонта неспешно пробегает светящаяся точка-импульс.
   */
  useGSAP(
    () => {
      const root = rootRef.current;

      if (root === null) {
        return;
      }

      const matchMedia = gsap.matchMedia();

      matchMedia.add(COSMOS_MEDIA, () => {
        const stops = [
          startNebulaBreath(root),
          startHorizonPulse(root),
          startPulsars(root),
          startDistantComet(root),
          startSupernova(root),
        ];

        return () => {
          for (const stop of stops) {
            stop();
          }
        };
      });

      return () => {
        matchMedia.revert();
      };
    },
    { scope: rootRef },
  );

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-testid="aurora-backdrop"
      className="aurora-backdrop"
    >
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
          {/*
           * Звёзды: «пыль» с плотным белым ядром и мягким голубым сходом и
           * редкие яркие звёзды с широким ореолом. Радиальные градиенты вместо
           * SVG-фильтров: слой остаётся статичным и дешёвым для композитора.
           */}
          <radialGradient id="galaxy-star-dust" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
            <stop offset="58%" stopColor="#dbe7ff" stopOpacity={0.7} />
            <stop offset="100%" stopColor="#a8bcff" stopOpacity={0.2} />
          </radialGradient>
          <radialGradient id="galaxy-star-bright" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="34%" stopColor="#eaf2ff" stopOpacity={0.85} />
            <stop offset="72%" stopColor="#b9cdff" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#8ea6ff" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="cosmos-horizon-spark-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.95} />
            <stop offset="38%" stopColor="#EAF2FF" stopOpacity={0.5} />
            <stop offset="72%" stopColor="#C7D8FF" stopOpacity={0.16} />
            <stop offset="100%" stopColor="#A8BCFF" stopOpacity={0} />
          </radialGradient>
          {/* Пульсары: плотное белое ядро и ледяной ореол */}
          <radialGradient id="cosmos-pulsar-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="42%" stopColor="#eaf2ff" stopOpacity={0.82} />
            <stop offset="100%" stopColor="#a8bcff" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="cosmos-pulsar-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#e0f2fe" stopOpacity={0.45} />
            <stop offset="55%" stopColor="#a8bcff" stopOpacity={0.14} />
            <stop offset="100%" stopColor="#8ea6ff" stopOpacity={0} />
          </radialGradient>
          {/* Комета: ледяное ядро `#E0F2FE` и растворяющийся к хвосту градиент */}
          <radialGradient id="cosmos-comet-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="42%" stopColor="#e0f2fe" stopOpacity={0.85} />
            <stop offset="100%" stopColor="#bae6fd" stopOpacity={0} />
          </radialGradient>
          <linearGradient id="cosmos-comet-tail" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#e0f2fe" stopOpacity={0} />
            <stop offset="52%" stopColor="#e0f2fe" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0.66} />
          </linearGradient>
          {/*
           * Сверхновая: раскалённый жёлто-золотой гигант `#FACC15` → `#F59E0B`
           * → `#EA580C` и тёплая золотая вспышка. Белого в палитре нет —
           * звезда не выжигает кадр в холодный пересвет.
           */}
          <radialGradient id="cosmos-supernova-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FACC15" stopOpacity={0.95} />
            <stop offset="38%" stopColor="#F59E0B" stopOpacity={0.66} />
            <stop offset="72%" stopColor="#EA580C" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#EA580C" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="cosmos-supernova-flash" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FDE68A" stopOpacity={0.92} />
            <stop offset="32%" stopColor="#FACC15" stopOpacity={0.62} />
            <stop offset="66%" stopColor="#F59E0B" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#EA580C" stopOpacity={0} />
          </radialGradient>
        </defs>

        {/*
         * Порядок слоёв: сначала галактическая дуга, затем органичное звёздное
         * поле — звёзды лежат поверх свечения горизонта и заполняют всё небо,
         * включая пространство над линией горизонта до самого верха окна.
         */}
        <g mask="url(#galaxy-edge-mask)">
          <EllipticalTrail trail={MAIN_TRAIL} />
          <StarField />
          {/* Дальний план: «Столпы Творения» — статичная миниатюра справа, у правой дуги горизонта */}
          <PillarsOfCreation />
          {/* Живое небо: цефеиды, далёкая комета и редкая сверхновая */}
          <PulsarField />
          <DistantComet />
          <Supernova />
        </g>
      </svg>

      <span className="aurora-ribbon aurora-ribbon--midnight animate-aurora-a" />
      <span className="aurora-ribbon aurora-ribbon--violet animate-aurora-b" />
      <span className="aurora-ribbon aurora-ribbon--ember animate-aurora-c" />
      <span className="aurora-ribbon aurora-ribbon--veil animate-aurora-a" />
      <span className="aurora-rays animate-aurora-d" />

      {/*
       * Пасхалка: корабль Trimaxion проходит по верхней дуге горизонта событий.
       * Клиентский островок монтируется только на desktop и при
       * `prefers-reduced-motion: no-preference`; на мобильных разметки в DOM нет.
       *
       * Слои (globals.css): весь фон, включая корабль, лежит в `.aurora-backdrop`
       * с `z-index: -1` — то есть на уровне canvas, строго ПОД контентом. Внутри
       * сцены ленты сияния — `z-index: 0`, дуги горизонта и звёздное поле с
       * маской `galaxy-edge-fade` — `z-index: 2`, корабль — `z-index: 4`.
       * Плотный непрозрачный корпус перекрывает светящуюся нить горизонта и
       * звёзды, а не просвечивает ими, но всё равно остаётся под
       * Bento-карточками (`z-index: 10`) и не перекрывает их текст.
       */}
      <TrimaxionPassage />
    </div>
  );
}

