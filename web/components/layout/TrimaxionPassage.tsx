"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * Условие пасхалки: только desktop и только когда пользователь не просил
 * уменьшить анимацию. Одна и та же строка используется и для монтирования
 * (matchMedia в useEffect), и для `gsap.matchMedia().add(...)` — поэтому
 * «не монтируется в DOM» и «не анимируется» гарантированно совпадают.
 */
export const TRIMAXION_MEDIA =
  "(prefers-reduced-motion: no-preference) and (min-width: 768px)";

/**
 * Пауза между проходами. Рождение из звезды занимает 4–5 s (`BIRTH_SEC`),
 * поэтому паузу укоротили ровно на это время: 10–18 s вместо 15–30 s.
 * Тишина между пролётами остаётся полноценной, но очередного корабля больше
 * не приходится ждать полминуты.
 */
const PAUSE_MIN_SEC = 10;
const PAUSE_MAX_SEC = 18;

/**
 * Зона полёта — строго верхние 20% высоты окна: от верхнего края до линии дуги
 * горизонта событий над Bento-карточками. Ни одна точка траектории (и ни один
 * кадр рендера) не выходит за эту полосу по Y, поэтому корабль не ныряет под
 * виджеты и не пропадает из вида.
 */
const FLIGHT_BAND_RATIO = 0.2;

/**
 * Дистанция в масштабе.
 *
 * `FAR_SCALE` — далёкая точка на горизонте: корабль-звезда, из которой он
 * проявляется и в которую сжимается. `NEAR_SCALE` — крейсерский масштаб:
 * столько корабль набирает, уходя вглубь или выходя из глубины. Силуэт
 * 320×128 px при 0.52 занимает ~166×67 px — монументально, читаемо, но без
 * «подиумного» выпрыгивания в камеру.
 */
const FAR_SCALE = 0.02;
const NEAR_SCALE = 0.52;

/**
 * Транзит вдоль горизонта: спокойный, почти ровный масштаб по очень пологой
 * дуге `0.46 → 0.52 → 0.46`. Корабль идёт по горизонту крупным силуэтом,
 * и его инженерная геометрия читается целиком.
 */
const TRANSIT_SCALE_MIN = 0.46;
const TRANSIT_SCALE_MAX = 0.52;

/**
 * Плотность корпуса. Заливка внутри SVG непрозрачна на 100%, а сам слой
 * держится на 0.96: металл перекрывает фоновые звёзды и не выглядит призраком.
 * Прозрачность зависит только от масштаба (в глубине силуэт растворяется),
 * а у кромок кадра корпус гасит mask-градиент сцены `.trimaxion-scene`.
 */
const HULL_OPACITY = 0.96;

/**
 * Хвост звезды: последние 3–4 s корабль сжимается в точку, и далёкая белая
 * звезда очень медленно угасает в темноте (`opacity: 1 → 0`).
 */
const STAR_FADE_SEC = 3.6;

/**
 * Кроссфейд «звезда → корпус».
 *
 * `STAR_CUTOFF_SCALE` — масштаб, на котором белая точка гаснет полностью.
 * `HULL_FADE_IN_SCALE` намеренно НИЖЕ этого порога: слои перекрываются, поэтому
 * в момент передачи эстафеты на экране всегда есть свет — единое плавное
 * нарастание без «щелчка» подмены слоёв. Полная плотность металла наступает к
 * `HULL_FADE_OUT_SCALE`, то есть уже на подходе к крейсерскому размеру.
 */
const STAR_CUTOFF_SCALE = 0.1;
const HULL_FADE_IN_SCALE = 0.05;
const HULL_FADE_OUT_SCALE = 0.16;

/** Один пролёт — 22–28 s: медленный, размеренный ход на всей дистанции. */
const FLIGHT_MIN_SEC = 22;
const FLIGHT_MAX_SEC = 28;

/**
 * Рождение корпуса из звезды. Точка-звезда не вспыхивает: она плавно
 * разгорается из темноты за `STAR_IGNITE_SEC`, а масштаб за `BIRTH_SEC`
 * (4–5 s) вырастает от `FAR_SCALE` до крейсерского `NEAR_SCALE`. Рост
 * экспоненциальный — как у объекта, летящего на камеру: силуэт «проявляется»
 * из точки и к концу окна уже держит полный крейсерский размер. Дальше
 * корабль просто идёт по лучу, поэтому никакого растянутого на весь пролёт
 * «выпрыгивания в камеру» нет.
 */
const BIRTH_SEC = 4.6;
const STAR_IGNITE_SEC = 1.8;

/**
 * Геометрия двигателей в перспективе 3/4.
 *
 * Базовая гондола нарисована в координатах viewBox (`0 0 240 96`): срез сопла —
 * `x = 236`, ось выхлопа — `y = 27.6`.
 *
 * Спарка стоит на кормовой плите БОК О БОК, а не друг над другом: дальняя
 * (верхняя) гондола сдвинута вниз к продольной оси и чуть влево, к носу — её
 * ось встаёт на `44.5`; ближняя (нижняя) — на `52.5`. Зазор 8 px viewBox вместо
 * прежних 17 px: пара читается как два двигателя в один ряд по глубине, а не
 * как «вертикальная двустволка».
 *
 * Дальняя гондола рисуется ПОД корпусом: её внутренняя половина уходит за
 * контур верхней спины (корпус её перекрывает), наружу выступают камера
 * сгорания и срез сопла. Именно это и даёт перспективу 3/4 — видно, что
 * двигателя два и они стоят в разных плоскостях по глубине.
 *
 * Шлейфы живут вне масштабируемой группы корпуса, поэтому их точки выхода
 * заданы в экранных пикселях сцены (SVG растянут на 320×128 px):
 * `x_px = (x / 240) × 320 − 160`, `y_px = (48 − y) × 128 / 96`.
 */

/** Масштаб гондолы: пара двигателей целиком помещается в высоту корпуса. */
const ENGINE_SCALE = 0.62;

/**
 * Компенсация масштаба для обводок: толщины линий внутри гондолы остаются
 * прежними (0.8 / 0.7 / 0.6 / 0.5 px viewBox), иначе после `scale(0.62)` они
 * истончились бы почти вдвое и силуэт «рассыпался» на крейсерском масштабе.
 */
const ENGINE_STROKE = 1 / ENGINE_SCALE;

/**
 * Посадка спарки: ось выхлопа дальней гондолы — `27.6 × 0.62 + 27.4 = 44.5`
 * (чуть выше продольной оси, ближе к носу на 6 px viewBox), зеркальной
 * ближней — `96 − (27.6 × 0.62 + 26.4) = 52.5` (чуть ниже оси, у самой
 * кормовой плиты). Зазор 8 px viewBox (≈ 5.6 px на крейсерском масштабе)
 * вместо прежних 17 px: сопла читаются горизонтально рядом, как пара
 * двигателей в 3/4, а не как вертикальная двустволка.
 */
const FAR_NOZZLE_OFFSET_X = 72;
const FAR_NOZZLE_OFFSET_Y = 27.4;

/** Сдвиг ближнего двигателя в viewBox: у самой кормовой плиты. */
const NEAR_NOZZLE_OFFSET_X = 78;
const NEAR_NOZZLE_OFFSET_Y = 26.4;

/** Выхлоп дальнего сопла: viewBox `(218.3; 44.5)` → экран `(131.1; 4.7)` px. */
const NOZZLE_FAR_X_PX = 131.1;
const NOZZLE_FAR_Y_PX = 4.7;

/** Выхлоп ближнего сопла: viewBox `(224.3; 52.5)` → экран `(139.1; 6.0)` px. */
const NOZZLE_NEAR_X_PX = 139.1;
const NOZZLE_NEAR_Y_PX = 6;

/**
 * Дуга «горизонта событий» в долях высоты сцены (34 rem = 544 px): парабола,
 * которая задаёт и траекторию полёта, и геометрию ближней нити горизонта в
 * AuroraBackdrop (там эта же парабола описана двумя квадратичными кривыми
 * Безье: вершина 120 px, края 53 и 90.2 px). Точки притяжения всех лучей лежат
 * на светящейся нити горизонта, а не в произвольном месте неба.
 */
const HORIZON_APEX_X = 0.6;
const HORIZON_APEX_Y = 0.2206;
const HORIZON_EDGE_DROP = 0.1232;

/**
 * Пять лучевых маршрутов «из точки в точку» в полосе горизонта:
 * — `rise-left`: из центра горизонта полого вверх к левому краю окна;
 * — `sweep-*`: касательный пролёт вдоль дуги горизонта вперёд и назад;
 * — `dive-*`: вылет из верхнего угла окна по диагонали вглубь ядра дуги.
 *
 * Вектор «из центра вправо» (`rise-right`) из списка убран намеренно: при таком
 * ходе нос корабля развёрнут к правой кромке, и в профильной проекции силуэт
 * визуально «скользит боком». Остались только органичные лучи — подъём
 * влево-вверх, касательные транзиты вдоль дуги и диагональные заходы из-за
 * кромки кадра.
 */
type TrajectoryKind =
  | "rise-left"
  | "sweep-forward"
  | "sweep-backward"
  | "dive-left"
  | "dive-right";

/**
 * Режим дистанции — от него зависит закон изменения масштаба:
 * — `transit`: ход вдоль горизонта, ровная дуга `0.46 → 0.52 → 0.46`;
 * — `outbound`: уход вглубь, линейно `0.52 → 0.02`;
 * — `inbound`: выход из глубины, линейно `0.02 → 0.52`.
 */
type FlightMode = "transit" | "outbound" | "inbound";

/** Сторона окна: `-1` — левая, `0` — ядро горизонта, `1` — правая. */
type Side = -1 | 0 | 1;

interface Vec {
  readonly x: number;
  readonly y: number;
}

interface SceneBox {
  readonly width: number;
  readonly height: number;
}

/** Кубическая кривая Безье: старт, две управляющие точки, финиш. */
interface FlightCurve {
  readonly from: Vec;
  readonly controlA: Vec;
  readonly controlB: Vec;
  readonly to: Vec;
}

interface FlightPlan {
  readonly kind: TrajectoryKind;
  readonly mode: FlightMode;
  readonly curve: FlightCurve;
  readonly pitch: number;
  readonly duration: number;
  /** С какой стороны корабль входит в кадр (`0` — из глубины по центру). */
  readonly enterSide: Side;
  /** В какую сторону он улетает (`0` — уходит вглубь по центру). */
  readonly leaveSide: Side;
}

/** Мгновенное состояние корпуса: масштаб, прозрачность, шлейф, плазма и блик. */
interface FlightProfile {
  readonly scale: number;
  readonly opacity: number;
  readonly trailOpacity: number;
  readonly trailLength: number;
  readonly sheen: number;
  readonly core: number;
  readonly plasma: number;
  readonly star: number;
  readonly glint: number;
}

/**
 * Память маршрутов: запрет повторять предыдущую траекторию подряд и входить
 * с той стороны, куда корабль только что улетел.
 */
interface RouteMemory {
  readonly kind: TrajectoryKind | null;
  readonly enterSide: Side;
  readonly leaveSide: Side;
}

const ROUTE_MEMORY_START: RouteMemory = { kind: null, enterSide: 0, leaveSide: 0 };

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Сглаженный переход 0 → 1: без рывков на границах фаз. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Точка на кривой Безье. */
function pointOnCurve(curve: FlightCurve, t: number): Vec {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;

  return {
    x: a * curve.from.x + b * curve.controlA.x + c * curve.controlB.x + d * curve.to.x,
    y: a * curve.from.y + b * curve.controlA.y + c * curve.controlB.y + d * curve.to.y,
  };
}

/**
 * Вектор скорости (первая производная кривой): именно он задаёт курс корабля,
 * поэтому нос всегда смотрит по направлению движения, включая развороты.
 */
function tangentOnCurve(curve: FlightCurve, t: number): Vec {
  const inverse = 1 - t;
  const a = 3 * inverse * inverse;
  const b = 6 * inverse * t;
  const c = 3 * t * t;

  return {
    x: a * (curve.controlA.x - curve.from.x) + b * (curve.controlB.x - curve.controlA.x) +
      c * (curve.to.x - curve.controlB.x),
    y: a * (curve.controlA.y - curve.from.y) + b * (curve.controlB.y - curve.controlA.y) +
      c * (curve.to.y - curve.controlB.y),
  };
}

/**
 * Курс корпуса в градусах: угол касательной к траектории. Если касательная
 * вырождена (управляющая точка кривой совпала со стартом и длина вектора почти
 * нулевая), берётся направление хорды «старт → финиш»: курс остаётся
 * определённым в любой точке, поэтому нос никогда не «моргает» на спавне.
 */
function headingDegrees(curve: FlightCurve, t: number): number {
  const tangent = tangentOnCurve(curve, t);

  if (Math.hypot(tangent.x, tangent.y) < 1e-6) {
    return (Math.atan2(curve.to.y - curve.from.y, curve.to.x - curve.from.x) * 180) / Math.PI;
  }

  return (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
}

/** Точка на светящейся дуге горизонта событий. */
function horizonPoint(box: SceneBox, xRatio: number): Vec {
  const offset = (xRatio - HORIZON_APEX_X) / HORIZON_APEX_X;
  return {
    x: box.width * xRatio,
    y: box.height * (HORIZON_APEX_Y - HORIZON_EDGE_DROP * offset * offset),
  };
}

/**
 * Верхняя граница полосы полёта в px: строго 20% высоты окна, но не выше самой
 * сцены (`.aurora-backdrop` = 34 rem). Сцена прибита к верхнему краю окна, так
 * что её координата Y совпадает с координатой окна.
 */
function flightBand(box: SceneBox): number {
  const viewport = typeof window === "undefined" ? box.height : window.innerHeight || box.height;
  return Math.min(box.height, Math.max(viewport, 1) * FLIGHT_BAND_RATIO);
}

/** Жёсткий кламп по вертикали: полёт не выходит из верхней полосы. */
function clampToBand(point: Vec, band: number): Vec {
  return {
    x: point.x,
    y: point.y < 0 ? 0 : point.y > band ? band : point.y,
  };
}

/** Ядро дуги (вершина горизонта) — центр притяжения всех лучей. */
function horizonApex(box: SceneBox, band: number): Vec {
  return {
    x: box.width * HORIZON_APEX_X,
    y: Math.min(box.height * HORIZON_APEX_Y, band * 0.92),
  };
}

/** Точка на светящейся дуге горизонта событий, гарантированно внутри полосы. */
function horizonBandPoint(box: SceneBox, band: number, xRatio: number): Vec {
  return clampToBand(horizonPoint(box, xRatio), band);
}

/**
 * Кубическая кривая «из точки в точку» с боковым отклонением `bow` (px):
 * управляющие точки вынесены вдоль хорды и смещены по нормали, поэтому курс
 * меняется плавно, а не «ломается» в середине. Контрольные точки тоже
 * клампятся в полосу — кривая не может вынырнуть из верхних 20% окна.
 */
function beamCurve(from: Vec, to: Vec, bow: number, band: number): FlightCurve {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;

  return {
    from,
    controlA: clampToBand(
      { x: from.x + dx * 0.34 + normalX * bow, y: from.y + dy * 0.34 + normalY * bow },
      band,
    ),
    controlB: clampToBand(
      { x: from.x + dx * 0.7 + normalX * bow * 0.8, y: from.y + dy * 0.7 + normalY * bow * 0.8 },
      band,
    ),
    to,
  };
}

/**
 * Луч 1 «Из глубины влево-вверх»: корабль рождается звездой у ядра дуги,
 * полого набирает высоту и уходит вдаль за левый край окна.
 * Масштаб растёт от `0.02` до крейсерского `0.52` — это выход из глубины на
 * зрителя, поэтому здесь честно работает фаза точки-звезды.
 *
 * Направление зафиксировано: зеркальный вариант «вправо» давал боковое
 * скольжение силуэта и из набора маршрутов удалён.
 */
function buildRisePlan(box: SceneBox, band: number): FlightPlan {
  const apex = horizonApex(box, band);

  const start = clampToBand(
    {
      x: apex.x - box.width * randomBetween(0.01, 0.06),
      y: apex.y - band * randomBetween(0, 0.06),
    },
    band,
  );
  const finish: Vec = {
    x: -box.width * randomBetween(1.04, 1.16),
    y: lerp(apex.y, band * 0.12, randomBetween(0.55, 0.8)),
  };

  return {
    kind: "rise-left",
    mode: "inbound",
    curve: beamCurve(start, finish, band * randomBetween(-0.12, 0.12), band),
    pitch: randomBetween(-6, 6),
    duration: randomBetween(FLIGHT_MIN_SEC, FLIGHT_MAX_SEC),
    enterSide: 0,
    leaveSide: -1,
  };
}

/**
 * Луч 3/4 «Касательный пролёт вдоль дуги»: корабль идёт по светящейся нити
 * горизонта от одного края окна к другому (слева направо или справа налево),
 * повторяя её прогиб к ядру. Обе управляющие точки задают прогиб в районе
 * вершины, поэтому кривая ложится точно на дугу. Режим — `transit`: ровный
 * масштаб `0.46 → 0.52 → 0.46` без зума в середине пути.
 *
 * Начало и конец вынесены за границы окна, поэтому корабль влетает из-за края
 * уже полноценным корпусом с раскрытыми шлейфами — без фазы точки у кромки.
 */
function buildSweepPlan(box: SceneBox, band: number, forward: boolean): FlightPlan {
  const apex = horizonApex(box, band);
  const left = horizonBandPoint(box, band, randomBetween(-0.09, -0.02));
  const right = horizonBandPoint(box, band, randomBetween(1.02, 1.09));
  const start = forward ? left : right;
  const finish = forward ? right : left;
  const sag = Math.min(apex.y + band * 0.04, band);

  return {
    kind: forward ? "sweep-forward" : "sweep-backward",
    mode: "transit",
    curve: {
      from: start,
      controlA: { x: lerp(start.x, finish.x, 0.32), y: sag },
      controlB: { x: lerp(start.x, finish.x, 0.68), y: sag },
      to: finish,
    },
    pitch: randomBetween(-5, 5),
    duration: randomBetween(FLIGHT_MIN_SEC, FLIGHT_MAX_SEC),
    enterSide: forward ? -1 : 1,
    leaveSide: forward ? 1 : -1,
  };
}

/**
 * Луч 5/6 «С края вглубь центра»: корабль вылетает из-за боковой границы окна
 * (уже полноценным корпусом с раскрытыми шлейфами) и уходит вдаль точно в ядро
 * дуги горизонта, где сжимается в точку-звезду и гаснет.
 * Масштаб падает от `0.52` до `0.02`.
 */
function buildDivePlan(box: SceneBox, band: number, side: -1 | 1): FlightPlan {
  const apex = horizonApex(box, band);

  /* Старт вынесен за кромку окна: на кадре нет фазы точки на краю экрана. */
  const start: Vec = {
    x: box.width * (side < 0 ? randomBetween(-0.14, -0.04) : randomBetween(1.04, 1.14)),
    y: band * randomBetween(0.02, 0.14),
  };
  const finish = clampToBand(
    {
      x: apex.x + box.width * randomBetween(-0.06, 0.06),
      y: apex.y + band * randomBetween(-0.04, 0.06),
    },
    band,
  );

  return {
    kind: side < 0 ? "dive-left" : "dive-right",
    mode: "outbound",
    curve: beamCurve(start, finish, band * randomBetween(-0.14, 0.14), band),
    pitch: randomBetween(-6, 6),
    duration: randomBetween(FLIGHT_MIN_SEC, FLIGHT_MAX_SEC),
    enterSide: side,
    leaveSide: 0,
  };
}

/**
 * Выбор маршрута с памятью. Собираем все пять лучей и отбрасываем:
 * 1) луч того же типа, что летел в прошлый раз (никакого повтора подряд);
 * 2) лучи, которые входят в кадр с той стороны, куда корабль только что улетел.
 * Если после фильтра не осталось ни одного варианта (например, после пролёта
 * слева-направо), ограничиваемся только запретом повтора типа.
 */
function buildFlightPlan(box: SceneBox, band: number, memory: RouteMemory): FlightPlan {
  const candidates: readonly FlightPlan[] = [
    buildSweepPlan(box, band, true),
    buildSweepPlan(box, band, false),
    buildDivePlan(box, band, -1),
    buildDivePlan(box, band, 1),
    buildRisePlan(box, band),
  ];

  const fresh = candidates.filter((plan) => plan.kind !== memory.kind);
  const screened = fresh.filter(
    (plan) => plan.enterSide === 0 || plan.enterSide !== memory.leaveSide,
  );
  const pool = screened.length > 0 ? screened : fresh.length > 0 ? fresh : candidates;

  return pool[Math.floor(Math.random() * pool.length)] as FlightPlan;
}

/**
 * Закон масштаба по режиму дистанции:
 * — `transit` — пологая дуга `0.46 → 0.52 → 0.46` (никакого «подиумного» зума);
 * — `outbound` — линейное сжатие `0.52 → 0.02` (медленное погружение в ядро);
 * — `inbound` — экспоненциальное рождение: за `BIRTH_SEC` (4–5 s) точка
 *   превращается в корпус и дальше держит крейсерский размер.
 */
function scaleAt(t: number, mode: FlightMode, duration: number): number {
  /* Доля пролёта, за которую звезда успевает стать корпусом. */
  const birthSpan = clamp01(BIRTH_SEC / Math.max(duration, BIRTH_SEC));

  switch (mode) {
    case "outbound":
      return lerp(NEAR_SCALE, FAR_SCALE, t);
    case "inbound":
      /*
       * Экспонента вместо линейного роста: объект, летящий на камеру,
       * увеличивается в геометрической прогрессии. Старт `smoothstep`-кривой
       * медленный, поэтому точка сначала долго тлеет и лишь затем мягко
       * раскрывается в силуэт — никакой вспышки и «выпрыгивания».
       */
      return FAR_SCALE * Math.pow(NEAR_SCALE / FAR_SCALE, smoothstep(0, birthSpan, t));
    default:
      return lerp(TRANSIT_SCALE_MIN, TRANSIT_SCALE_MAX, Math.sin(Math.PI * t));
  }
}

/**
 * Мгновенный профиль пролёта. Драматургия привязана к масштабу, а не к времени:
 *
 * 1. точка-звезда плавно разгорается из темноты (`STAR_IGNITE_SEC`), живёт
 *    только в глубине (`scale <= STAR_CUTOFF_SCALE`) и передаёт эстафету
 *    корпусу мягко, без вспышки в первом кадре;
 * 2. корпус, плазма и оба шлейфа проявляются по масштабу с `HULL_FADE_IN_SCALE`
 *    и выходят на полную плотность к `HULL_FADE_OUT_SCALE`: окно проявления
 *    перекрывается с угасанием звезды, поэтому слои перетекают друг в друга
 *    единым нарастанием без «щелчка» подмены;
 * 3. уходя вглубь, корабль снова сжимается в точку (`0.02`), и последние
 *    `STAR_FADE_SEC` секунд белая звезда очень медленно угасает в темноте.
 *
 * Поэтому у пролёта из-за края окна (`sweep-*`, `dive-*`) фазы точки на кромке
 * нет вовсе: масштаб там крейсерский, корпус и шлейфы раскрыты с первого кадра.
 * Все величины считаются аналитически от прогресса `t`, поэтому корпус, плазма,
 * шлейфы и звезда всегда согласованы, а траектория остаётся единственной
 * непрерывной кривой — без остановок и рывков.
 */
function flightProfile(t: number, mode: FlightMode, duration: number): FlightProfile {
  const scale = scaleAt(t, mode, duration);
  /* 0 — далёкая точка, 1 — крейсерский масштаб: по нему гаснут шлейфы. */
  const proximity = clamp01((scale - FAR_SCALE) / (NEAR_SCALE - FAR_SCALE));

  /*
   * Плотность корпуса — функция масштаба. Проявление начинается ДО того, как
   * погасла звезда (`HULL_FADE_IN_SCALE < STAR_CUTOFF_SCALE`), поэтому эстафета
   * «точка → металл» идёт кроссфейдом: слои накладываются, суммарная яркость
   * не проваливается в ноль и подмена не читается щелчком.
   */
  const hull = smoothstep(HULL_FADE_IN_SCALE, HULL_FADE_OUT_SCALE, scale);

  /*
   * Далёкая звезда: 1 на горизонте (`scale = FAR`), ровно 0 при
   * `scale >= STAR_CUTOFF_SCALE`. Ядро блика на корпусе (`core`) к этому
   * моменту уже разгорается, так что свет с экрана не исчезает. Финальное
   * угасание — только для ухода вглубь, когда корабль сжался в точку.
   */
  const depth = clamp01((STAR_CUTOFF_SCALE - scale) / (STAR_CUTOFF_SCALE - FAR_SCALE));
  const fadeSpan = clamp01(STAR_FADE_SEC / Math.max(duration, STAR_FADE_SEC));
  const starFadeOut = 1 - smoothstep(1 - fadeSpan, 1, t);
  /*
   * Разгорание из темноты: в самом первом кадре яркость ровно 0, поэтому
   * точка не вспыхивает мгновенно, а проявляется гипнотически медленно.
   */
  const igniteSpan = clamp01(STAR_IGNITE_SEC / Math.max(duration, STAR_IGNITE_SEC));
  const ignite = smoothstep(0, igniteSpan, t);
  const star = smoothstep(0, 1, depth) * starFadeOut * ignite;

  return {
    scale,
    opacity: HULL_OPACITY * hull,
    /* Оба шлейфа тянутся от сопел всё время, пока виден корпус. */
    trailOpacity: 0.92 * hull * (0.5 + 0.5 * proximity),
    /* Базовая полоса 240 px × scaleX ∈ [0.3, 1.08] → 72–259 px видимой длины. */
    trailLength: 0.3 + 0.78 * proximity,
    /* Сатин, а не зеркало: перелив мягкий и не выбеливает платину. */
    sheen: 0.32 + 0.5 * hull,
    core: 0.3 * hull,
    /* Плазма горит ярче всего сзади: когда корабль улетает вглубь или выходит из неё. */
    plasma: (0.62 + 0.38 * (1 - proximity)) * hull,
    star,
    glint: Math.sin(t * Math.PI * 3) * 16,
  };
}

/**
 * Пасхалка «Корабль Trimaxion в глубине горизонта событий».
 *
 * Полёт живёт строго в верхней полосе окна — верхние 20% высоты экрана, от
 * верхнего края до линии дуги горизонта над Bento-карточками. Каждый пролёт —
 * один из пяти лучей «из точки в точку»:
 * 1. выход из глубины влево-вверх к левому краю окна (`inbound`, `0.02 → 0.52`);
 * 2. касательный транзит вдоль дуги горизонта слева направо (`transit`, ровный
 *    масштаб `0.46 → 0.52 → 0.46`);
 * 3. то же справа налево;
 * 4. уход вглубь ядра дуги с левого края окна (`outbound`, `0.52 → 0.02`);
 * 5. то же с правого края.
 *
 * Зеркальный «выход из центра вправо» из набора убран: при развороте носа к
 * правой кромке силуэт визуально скользил боком, поэтому остались только
 * органичные направления — влево-вверх, касательные транзиты и диагональные
 * заходы из-за кромки кадра.
 *
 * Внутри пролёта ровно один непрерывный таймлайн GSAP на 22–28 s: медленный,
 * размеренный ход без остановок, зависаний и «отталкиваний». Кривая
 * `sine.inOut` гасит скорость у обеих кромок кадра, поэтому корабль не
 * проскакивает края экрана рывком, а плавно вплывает и растворяется за ним.
 * Масштаб, прозрачность, плазма, шлейфы и звезда считаются аналитически от
 * прогресса (`flightProfile`), поэтому рождение звездой и уход в темноту на
 * концах луча читаются как продолжение движения, а не как пауза. Курс всегда
 * совпадает с касательной к траектории (`atan2(dy, dx)`); из 3D остаётся только
 * лёгкий тангаж `rotateX`, поэтому корабль держит строгий боковой профиль и
 * показывает компактную горизонтальную спарку двигателей. Между пролётами пауза
 * 10–18 s, а рождение из звезды занимает 4–5 s: ритм остаётся спокойным, но
 * ждать долго не приходится.
 *
 * Предыдущий маршрут и стороны входа/выхода хранятся в `useRef`: один и тот же
 * луч не повторяется подряд, и корабль не входит в кадр с той стороны, куда
 * только что улетел.
 *
 * Ресурсы: один силуэт 240×96, только `transform`/`opacity`/CSS-переменные
 * (композиторные свойства), никаких постоянных CSS-анимаций. На мобильных и при
 * `prefers-reduced-motion` компонент не рендерит разметку вовсе.
 */
export function TrimaxionPassage(): ReactElement | null {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(TRIMAXION_MEDIA);
    const sync = (): void => {
      setEnabled(query.matches);
    };

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return enabled ? <ShipFlight /> : null;
}

/** Сцена одного корабля: монтируется только после подтверждения media-условия. */
function ShipFlight(): ReactElement {
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const orientRef = useRef<HTMLDivElement | null>(null);
  const shipRef = useRef<HTMLDivElement | null>(null);
  const starRef = useRef<HTMLSpanElement | null>(null);
  const trailTopRef = useRef<HTMLSpanElement | null>(null);
  const trailBottomRef = useRef<HTMLSpanElement | null>(null);

  /**
   * Память маршрутов живёт в `useRef` (а не в замыкании таймлайна): она должна
   * переживать пересоздание `matchMedia`-скоупа и оставаться единственным
   * источником правды о том, куда корабль улетел в прошлый раз.
   */
  const routeRef = useRef<RouteMemory>(ROUTE_MEMORY_START);

  useGSAP(
    () => {
      const scene = sceneRef.current;
      const anchor = anchorRef.current;
      const orient = orientRef.current;
      const ship = shipRef.current;
      const star = starRef.current;
      const trailTop = trailTopRef.current;
      const trailBottom = trailBottomRef.current;

      if (
        scene === null ||
        anchor === null ||
        orient === null ||
        ship === null ||
        star === null ||
        trailTop === null ||
        trailBottom === null
      ) {
        return;
      }

      const trails: readonly HTMLElement[] = [trailTop, trailBottom];
      const matchMedia = gsap.matchMedia();

      matchMedia.add(TRIMAXION_MEDIA, () => {
        gsap.set(ship, {
          xPercent: -50,
          yPercent: -50,
          transformPerspective: 900,
          transformOrigin: "50% 50%",
        });
        gsap.set(trails, { transformOrigin: "0% 50%" });
        /* Далёкая звезда центрируется на якоре траектории. */
        gsap.set(star, { xPercent: -50, yPercent: -50 });

        let pauseCall: gsap.core.Tween | null = null;
        let running: gsap.core.Timeline | null = null;

        /*
         * Флаг остановки цикла. `onComplete` последнего пролёта успевал
         * поставить новый `delayedCall` уже после очистки скоупа, и цепочка
         * «пауза → пролёт → пауза» продолжала жить: корабль больше не
         * появлялся, но таймеры не отпускали друг друга. С флагом цикл
         * гарантированно умирает вместе с `matchMedia`-скоупом и корректно
         * перезапускается при повторном монтировании.
         */
        let stopped = false;

        const schedule = (): void => {
          if (stopped) {
            return;
          }

          /* Предыдущая пауза снимается: в очереди всегда ровно один таймер. */
          pauseCall?.kill();
          pauseCall = gsap.delayedCall(randomBetween(PAUSE_MIN_SEC, PAUSE_MAX_SEC), runPass);
        };

        const runPass = (): void => {
          if (stopped) {
            return;
          }

          const rect = scene.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            schedule();
            return;
          }

          running?.kill();
          running = null;

          const box: SceneBox = { width: rect.width, height: rect.height };
          const band = flightBand(box);
          /*
           * Маршрут выбирается с памятью о прошлом пролёте: тот же луч не
           * повторяется подряд, и корабль не входит с той стороны, куда только
           * что улетел. Выбор сразу фиксируется в `routeRef`.
           */
          const plan = buildFlightPlan(box, band, routeRef.current);
          routeRef.current = {
            kind: plan.kind,
            enterSide: plan.enterSide,
            leaveSide: plan.leaveSide,
          };

          /* Накопленный курс: разворачиваем углы по кратчайшей дуге, чтобы на
           * переходе через ±180° корабль не «прыгал» на полный оборот. */
          let previousRotation: number | null = null;
          const unwrap = (degrees: number): number => {
            if (previousRotation === null) {
              previousRotation = degrees;
              return degrees;
            }

            let next = degrees;
            while (next - previousRotation > 180) {
              next -= 360;
            }
            while (next - previousRotation < -180) {
              next += 360;
            }
            previousRotation = next;
            return next;
          };

          const flight = { t: 0 };

          const render = (): void => {
            const profile = flightProfile(flight.t, plan.mode, plan.duration);
            /* Позиция жёстко клампится в верхнюю полосу окна (0…20% высоты). */
            const position = clampToBand(pointOnCurve(plan.curve, flight.t), band);

            /* Нос модели смотрит в −X, поэтому к углу вектора скорости + 180°. */
            gsap.set(anchor, { x: position.x, y: position.y });
            gsap.set(orient, { rotation: unwrap(headingDegrees(plan.curve, flight.t) + 180) });
            /*
             * Строгий боковой профиль: 3D-разворот `rotateY` к камере убран —
             * он показывал срезы сопел «в лицо» и превращал спарку в
             * вертикальную двустволку. Остаётся только лёгкий `rotateX`
             * (тангаж ±5–6°), который читается как наклон корпуса в полёте, но
             * не разворачивает двигатели на зрителя.
             */
            gsap.set(ship, {
              scale: profile.scale,
              opacity: profile.opacity,
              rotateX: plan.pitch,
              "--trimaxion-sheen": profile.sheen,
              "--trimaxion-core": profile.core,
              "--trimaxion-plasma": profile.plasma,
              "--trimaxion-glint-x": `${profile.glint}px`,
            });
            gsap.set(star, { opacity: profile.star });

            /*
             * Шлейфы растут строго из своих сопел: точки выхода масштабируются
             * вместе с корпусом, длина (`scaleX`) и прозрачность приходят из
             * профиля. Сопла стоят в 3/4: дальнее чуть выше оси (4.7 px),
             * ближнее — чуть ниже (6 px), а по горизонту они разнесены на 8 px,
             * поэтому полосы идут рядом, но не сливаются в одну струю. Дальний
             * след короче, тоньше и бледнее — двигатель глубже в кадре, и пара
             * читается объёмно.
             */
            /* Толщина шлейфа тоже идёт за корпусом: на крейсере она плотнее. */
            const trailThickness = 0.85 + profile.scale * 1.1;
            gsap.set(trailTop, {
              x: NOZZLE_FAR_X_PX * profile.scale,
              y: -NOZZLE_FAR_Y_PX * profile.scale,
              scaleX: profile.trailLength * 0.94,
              scaleY: trailThickness * 0.88,
              opacity: profile.trailOpacity * 0.86,
            });
            gsap.set(trailBottom, {
              x: NOZZLE_NEAR_X_PX * profile.scale,
              y: NOZZLE_NEAR_Y_PX * profile.scale,
              scaleX: profile.trailLength,
              scaleY: trailThickness,
              opacity: profile.trailOpacity,
            });
          };

          /*
           * Стартовый кадр — ДО запуска таймлайна. Курс считается по
           * касательной в точке спавна и применяется отдельным `gsap.set`:
           * к первому отрисованному кадру нос уже смотрит строго по вектору
           * движения. Раньше корпус успевал показаться с нулевым углом и
           * «выплывал боком», разворачиваясь уже на ходу; заодно
           * `previousRotation` праймится стартовым углом, поэтому `unwrap` не
           * может скачком добавить лишний оборот на первом тике.
           */
          const startRotation = headingDegrees(plan.curve, 0) + 180;
          previousRotation = startRotation;
          gsap.set(orient, { rotation: startRotation });
          render();

          const timeline = gsap.timeline({
            onUpdate: render,
            onComplete: () => {
              running = null;
              schedule();
            },
          });

          running = timeline;

          /*
           * Один непрерывный твин на весь пролёт. Кривая `sine.inOut` — это
           * выровненный шаг Безье `0.42, 0, 0.58, 1`: разгон и торможение
           * симметричны, поэтому у обеих кромок кадра корабль идёт медленно и
           * не проскакивает экран рывком. Масштаб остаётся линейной функцией
           * прогресса, так что глубина и проявление корпуса согласованы.
           */
          timeline.to(flight, { t: 1, duration: plan.duration, ease: "sine.inOut" }, 0);
        };

        /* Первый проход — сразу после загрузки, дальше ритм задаёт пауза 10–18 s. */
        runPass();

        /*
         * Очистка: сначала снимаем флаг (цикл больше не продлевается сам),
         * затем убиваем и паузу, и текущий пролёт. Контекст GSAP после этого
         * откатывает все `set`-ы к исходным значениям, поэтому следующий
         * монтаж начинается с чистого листа — без «зависшего» корабля.
         */
        return () => {
          stopped = true;
          pauseCall?.kill();
          pauseCall = null;
          running?.kill();
          running = null;
        };
      });

      return () => {
        matchMedia.revert();
      };
    },
    { scope: sceneRef },
  );

  return (
    <div
      ref={sceneRef}
      className="trimaxion-scene"
      data-testid="trimaxion-scene"
      aria-hidden="true"
    >
      <div ref={anchorRef} className="trimaxion-anchor">
        {/* Далёкая белая звезда: живёт только в глубине и гаснет к проявлению корпуса */}
        <span ref={starRef} className="trimaxion-star" />
        <div ref={orientRef} className="trimaxion-orient">
          {/* Двойной инверсионный шлейф: по одному следу от каждого сопла */}
          <span ref={trailTopRef} className="trimaxion-trail" />
          <span ref={trailBottomRef} className="trimaxion-trail" />
          <div ref={shipRef} className="trimaxion-ship">
            <FlightHull className="trimaxion-hull" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Геометрия корпуса в координатах viewBox `0 0 240 96`.
 *
 * Асимметрия силуэта читается безошибочно:
 * — нос (слева, всегда по вектору движения) — гладкий закруглённо-клиновидный,
 *   без выступов и стабилизаторов;
 * — корма (справа) — усечённая ступенчатая плита, поверх которой по краям
 *   вынесены два двигателя-гондолы с соплами. Между соплами остаётся вырез,
 *   поэтому силуэт не читается как симметричная «сосиска».
 */
const HULL_PATH =
  "M3 48 C16 43.5 38 37.5 66 32.5 C96 27.5 128 24.5 158 24 L176 24.6 " +
  "C186 25.2 194 28 199 32.5 L199 63.5 C194 68 186 70.8 176 71.4 L158 72 " +
  "C128 71.5 96 68.5 66 63.5 C38 58.5 16 52.5 3 48 Z";

/**
 * Гондола двигателя в базовых координатах: корпус гондолы, камера сгорания и
 * вертикальный срез сопла (`x = 236`). Рисуется один раз и переиспользуется
 * двумя двигателями — прямым и зеркальным, поэтому спарка гарантированно
 * симметрична и стоит в одной плоскости с корпусом (строгий боковой профиль).
 */
const NACELLE_PATH =
  "M188 24.5 C196 18.5 206 14.5 218 13.6 L228 14.4 C233.5 15.4 236 18.6 236 22.4 " +
  "L236 33 C236 36.2 233 38.4 227 38.9 L209 39.4 C199 39.8 192 33 188 24.5 Z";

/**
 * Панорамный обзорный иллюминатор в носовой части корпуса.
 *
 * Линза повторяет обвод носа: верхняя кромка идёт параллельно верхней скуле
 * (смещение внутрь корпуса ~1.5 px), обе кромки сходятся в острие у носа и в
 * точке под кабиной. Поэтому стекло читается как единая панорамная полоса
 * бронестекла, а не как отдельная «форточка», и вокруг него остаётся полоса
 * платиновой обшивки — так иллюминатор сидит в силовом наборе.
 *
 * Интерьер и экипаж за стеклом не рисуются вообще: заливка — от глубокого
 * космического графита `#090D16` к холодному индиго `#0284C7`, то есть стекло
 * только отражает небо. «Стеклянность» доказывают две вещи — тонкий
 * металлический шпангоут по контуру и узкий диагональный блик из ледяного
 * `#E0F2FE`.
 */
const WINDOW_PATH =
  "M8.2 47.3 C16.4 44.9 28.6 41.9 42.6 38.6 C56 35.5 72 32.8 84.4 31.2 " +
  "C87 30.8 89.2 31.6 90.2 33.6 C87.6 36.4 84.6 38.2 80.6 39.2 " +
  "C60 43.2 40 47.2 23 50.2 C17.6 51.2 13.6 50.6 8.2 47.3 Z";

export interface FlightHullProps {
  readonly className?: string;
}

/**
 * Один двигатель: гондола, камера сгорания, срез сопла и плазма внутри.
 *
 * Гондола уменьшена до `ENGINE_SCALE` и посажена на кормовую плиту со сдвигом
 * `offsetX` / `offsetY`. `mirrored` — зеркальная копия по горизонтальной оси
 * (`y → 96 − y`), поэтому ближний двигатель ставится под продольной осью.
 * Смещения разные: дальняя гондола сидит чуть выше и ближе к носу, ближняя —
 * чуть ниже и у самой кормы, из-за чего пара читается в перспективе 3/4.
 * `far` помечает дальний двигатель: он чуть приглушён дымкой расстояния и
 * рисуется ПОД корпусом, поэтому его внутренняя половина уходит за контур
 * верхней спины.
 */
interface NozzleProps {
  readonly mirrored?: boolean;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly far?: boolean;
}

function Nozzle({
  mirrored = false,
  offsetX = 0,
  offsetY = 0,
  far = false,
}: NozzleProps): ReactElement {
  /*
   * Порядок трансформов важен: сначала гондола уменьшается и сдвигается на
   * кормовую плиту, и только потом (для второго двигателя) зеркалится — так
   * обе гондолы оказываются на равном расстоянии от оси `y = 48`.
   */
  const transform = `${mirrored ? "matrix(1 0 0 -1 0 96) " : ""}translate(${offsetX} ${offsetY}) scale(${ENGINE_SCALE})`;

  return (
    <g transform={transform} opacity={far ? 0.92 : 1}>
      <path
        d={NACELLE_PATH}
        fill="url(#trimaxion-flight-platinum)"
        stroke="#64748B"
        strokeOpacity="0.8"
        strokeWidth={0.8 * ENGINE_STROKE}
        strokeLinejoin="round"
      />
      <path
        d="M192 21.4 C201 16.4 210 14.6 220 14.2"
        stroke="#E2E8F0"
        strokeOpacity="0.55"
        strokeWidth={0.7 * ENGINE_STROKE}
        strokeLinecap="round"
      />
      <path
        d="M188 24.5 C198 33 209 39.4 227 38.9"
        stroke="#94A3B8"
        strokeOpacity="0.4"
        strokeWidth={0.6 * ENGINE_STROKE}
        strokeLinecap="round"
      />
      {/* Камера сгорания и срез сопла: тёмный зев на фоне платины */}
      <path
        d="M226 19.6 L230.6 20.8 L230.6 34.4 L226 35.6 Z"
        fill="#1E293B"
        stroke="#64748B"
        strokeWidth={0.5 * ENGINE_STROKE}
        strokeLinejoin="round"
      />
      <rect
        x="230.4"
        y="21.8"
        width="5.6"
        height="11.6"
        rx="1.8"
        fill="#0B1220"
        stroke="#94A3B8"
        strokeOpacity="0.6"
        strokeWidth={0.6 * ENGINE_STROKE}
      />
      {/*
       * Плазма: тёплое ядро без выбеливания. Красный ореол → раскалённый
       * оранжевый → золотисто-жёлтый центр; `mix-blend-mode: normal` в CSS
       * не даёт screen-режиму выжечь цвет в белый.
       */}
      <g className="trimaxion-plasma">
        <ellipse cx="233.6" cy="27.6" rx="4.2" ry="7.6" fill="url(#trimaxion-flight-plasma)" />
        <ellipse cx="233.2" cy="27.6" rx="2.6" ry="5.2" fill="url(#trimaxion-flight-plasma)" />
        <ellipse cx="233.4" cy="27.6" rx="1.2" ry="2.6" fill="#FACC15" />
        <circle cx="233.6" cy="26.4" r="0.8" fill="#FDE047" />
      </g>
    </g>
  );
}

/**
 * Корпус Trimaxion для пасхалки: глубокая матовая платина с горячими
 * плазменными соплами.
 *
 * Слои заливки строго снизу вверх:
 * 1. дальняя гондола — рисуется ПОД корпусом, поэтому её внутренняя половина
 *    уходит за контур верхней спины (перспектива 3/4);
 * 2. базовый корпус — **непрозрачная** матовая платина `#E2E8F0 → #CBD5E1 →
 *    #D6D3D1 → #94A3B8 → #64748B` (звёзды за корпусом не просвечивают, силуэт
 *    не выглядит призраком, а тёплый серебристый полутон даёт благородный металл);
 * 3. мягкий сатиновый блик по верхней грани и носу — без зеркального «хрома»;
 * 4. переливающаяся полоса (`--trimaxion-glint-x`) и ядро блика
 *    (`--trimaxion-core`) — металл «играет» в движении;
 * 5. тонкий серебристый кант `#E2E8F0` по контуру;
 * 6. два сопла с горячей плазмой (`#DC2626` / `#F97316` / `#FACC15`), яркость
 *    которых задаёт `--trimaxion-plasma` — сзади она максимальна. Гондолы
 *    посажены спаркой БОК О БОК: дальняя чуть выше и ближе к носу, ближняя —
 *    чуть ниже и у самой кормовой плиты, поэтому в 3/4 пара читается как два
 *    двигателя в ряд по глубине, а не как вертикальная двустволка. Разворота
 *    корпуса к камере (`rotateY`) нет — только строгий боковой профиль.
 *
 * Все id градиентов с префиксом `trimaxion-flight-`: компонент монтируется
 * в единственном экземпляре и не конфликтует с брендовым `TrimaxionShip`.
 */
function FlightHull({ className }: FlightHullProps): ReactElement {
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
        {/*
         * Базовая заливка: глубокая матовая платина, непрозрачная на 100%.
         * Светлый титан уходит в плотную платину, в середине появляется тёплый
         * серебристый полутон, книзу ложится приглушённая тень. Перепад широкий
         * и ровный — сатиновый металл без зеркального «хрома» и кислотных бликов.
         */}
        <linearGradient id="trimaxion-flight-platinum" x1="0.08" y1="0.02" x2="0.62" y2="1">
          <stop offset="0%" stopColor="#E2E8F0" />
          <stop offset="26%" stopColor="#CBD5E1" />
          <stop offset="46%" stopColor="#D6D3D1" />
          <stop offset="70%" stopColor="#94A3B8" />
          <stop offset="100%" stopColor="#64748B" />
        </linearGradient>
        {/* Мягкий сатиновый блик верхней грани: полупрозрачное серебро, не зеркало */}
        <linearGradient id="trimaxion-flight-chrome" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="#F8FAFC" stopOpacity="0.4" />
          <stop offset="34%" stopColor="#E2E8F0" stopOpacity="0.22" />
          <stop offset="70%" stopColor="#CBD5E1" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#CBD5E1" stopOpacity="0" />
        </linearGradient>
        {/* Отдельная подсветка носа: клин собирает свет в острие */}
        <radialGradient id="trimaxion-flight-nose" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#F1F5F9" stopOpacity="0.42" />
          <stop offset="46%" stopColor="#CBD5E1" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#CBD5E1" stopOpacity="0" />
        </radialGradient>
        {/* Рельеф центрального пояса: приглушённая тень сверху и снизу */}
        <linearGradient id="trimaxion-flight-belt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#64748B" stopOpacity="0.5" />
          <stop offset="42%" stopColor="#E2E8F0" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#64748B" stopOpacity="0.55" />
        </linearGradient>
        {/* Перелив: серебристое ядро полосы и тёплый полутон на сходе */}
        <linearGradient id="trimaxion-flight-glint" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#F8FAFC" stopOpacity="0" />
          <stop offset="42%" stopColor="#F1F5F9" stopOpacity="0.28" />
          <stop offset="54%" stopColor="#FFFFFF" stopOpacity="0.42" />
          <stop offset="66%" stopColor="#D6D3D1" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#D6D3D1" stopOpacity="0" />
        </linearGradient>
        {/* Плазма: золотисто-жёлтое ядро → оранжевый → глубокий красный край */}
        <radialGradient id="trimaxion-flight-plasma" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#FACC15" stopOpacity="1" />
          <stop offset="26%" stopColor="#FACC15" stopOpacity="0.96" />
          <stop offset="54%" stopColor="#F97316" stopOpacity="0.92" />
          <stop offset="80%" stopColor="#DC2626" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#DC2626" stopOpacity="0" />
        </radialGradient>
        {/* Ядро блика: сюда «перетекает» далёкая звезда при подходе */}
        <radialGradient id="trimaxion-flight-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#F8FAFC" stopOpacity="0.45" />
          <stop offset="38%" stopColor="#E2E8F0" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#CBD5E1" stopOpacity="0" />
        </radialGradient>
        {/*
         * Панорамный обзорный иллюминатор.
         *
         * Бронестекло: от глубокого космического графита `#090D16` у острия носа
         * к холодному индиго `#0284C7` под кабиной. Стекло не «светится изнутри»
         * и не показывает интерьер — оно отражает небо, поэтому заливка остаётся
         * плотной и тёмной.
         */}
        <linearGradient id="trimaxion-flight-window" x1="0.05" y1="0.1" x2="0.95" y2="0.95">
          <stop offset="0%" stopColor="#090D16" stopOpacity="0.98" />
          <stop offset="46%" stopColor="#0B1A2E" stopOpacity="0.96" />
          <stop offset="100%" stopColor="#0284C7" stopOpacity="0.82" />
        </linearGradient>
        {/* Шпангоут: тонкий металлический кант, светлый на верхней дуге линзы */}
        <linearGradient id="trimaxion-flight-window-frame" x1="0" y1="0" x2="0.82" y2="1">
          <stop offset="0%" stopColor="#E2E8F0" stopOpacity="0.9" />
          <stop offset="52%" stopColor="#94A3B8" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#64748B" stopOpacity="0.7" />
        </linearGradient>
        {/*
         * Стеклянный блик: ледяной `#E0F2FE` на верхней кромке, растворяющийся
         * в прозрачность к низу. Координаты `userSpaceOnUse` привязаны к полосе
         * остекления, поэтому блик гарантированно гаснет внутри линзы и не
         * «зажигает» соседнюю обшивку.
         */}
        <linearGradient
          id="trimaxion-flight-window-sheen"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="29"
          x2="0"
          y2="54"
        >
          <stop offset="0%" stopColor="#E0F2FE" stopOpacity="0.62" />
          <stop offset="45%" stopColor="#E0F2FE" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#E0F2FE" stopOpacity="0" />
        </linearGradient>
        {/*
         * Отдельный клип самой линзы. Нужен блику: контура корпуса мало — без
         * него диагональная полоса вылезла бы на платиновую обшивку над и под
         * стеклом. Шпангоут при этом остаётся внутри `hull-clip`.
         */}
        <clipPath id="trimaxion-flight-window-clip">
          <path d={WINDOW_PATH} />
        </clipPath>
        <clipPath id="trimaxion-flight-hull-clip">
          <path d={HULL_PATH} />
        </clipPath>
      </defs>

      {/*
       * 1. Дальний двигатель: рисуется ПЕРВЫМ, поэтому непрозрачный корпус
       * перекрывает его внутреннюю половину — гондола частично уходит за
       * контур верхней спины, и пара сопел читается в перспективе 3/4, а не
       * как вертикальная двустволка. Наружу остаются камера сгорания и срез
       * сопла за кормовой плитой.
       */}
      <Nozzle offsetX={FAR_NOZZLE_OFFSET_X} offsetY={FAR_NOZZLE_OFFSET_Y} far />

      {/*
       * 2. Корпус: непрозрачная матовая платина — звёзды не просвечивают.
       * Двигатели рисуются вокруг этого слоя (см. пункты 1 и 10): дальний ПОД
       * корпусом, ближний поверх кормовой плиты.
       */}
      <path d={HULL_PATH} fill="url(#trimaxion-flight-platinum)" />

      {/* 3. Сатиновый блик: верхняя грань, нос и рельеф центрального пояса */}
      <g clipPath="url(#trimaxion-flight-hull-clip)">
        <rect x="0" y="0" width="240" height="48" fill="url(#trimaxion-flight-chrome)" />
        <ellipse cx="42" cy="45" rx="62" ry="15" fill="url(#trimaxion-flight-nose)" />
        <rect x="0" y="43" width="240" height="10" fill="url(#trimaxion-flight-belt)" />
      </g>

      {/* 4. Перелив: полоса света по корпусу, смещается CSS-переменной */}
      <g clipPath="url(#trimaxion-flight-hull-clip)" className="trimaxion-glint">
        <rect x="-96" y="0" width="150" height="96" fill="url(#trimaxion-flight-glint)" />
      </g>

      {/* 5. Световой кант: тонкая серебристая кромка по всему контуру */}
      <path
        d={HULL_PATH}
        fill="none"
        stroke="#E2E8F0"
        strokeOpacity="0.55"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />

      {/* 6. Ступенчатая корма: приглушённая плита и её светлая кромка */}
      <path d="M190 33.4 L199 33.4 L199 62.6 L190 62.6 Z" fill="#64748B" fillOpacity="0.6" />
      <path d="M199 33.4 L199 62.6" stroke="#E2E8F0" strokeOpacity="0.5" strokeWidth="0.8" />

      {/* 7. Швы обшивки: тень шва и светлая грань рядом — панельный металл */}
      <path d="M96 27 C101 36 101 60 96 69" stroke="#64748B" strokeOpacity="0.55" strokeWidth="0.8" />
      <path
        d="M97.6 28 C102 36 102 59 97.6 68"
        stroke="#F1F5F9"
        strokeOpacity="0.25"
        strokeWidth="0.5"
      />
      <path
        d="M150 24.6 C156 34 156 62 150 71.4"
        stroke="#64748B"
        strokeOpacity="0.5"
        strokeWidth="0.7"
      />
      <path
        d="M151.6 25.6 C157 34 157 61 151.6 70.4"
        stroke="#F1F5F9"
        strokeOpacity="0.22"
        strokeWidth="0.5"
      />

      {/* 8. Позвоночная грань, блик полировки и кромка верхней грани */}
      <path d="M14 48 L196 48" stroke="#64748B" strokeOpacity="0.38" strokeWidth="0.7" />
      <path
        d="M22 41 C48 34 80 28.6 112 25.8"
        stroke="#F8FAFC"
        strokeOpacity="0.5"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path
        d="M7 47.4 C26 41.2 52 35.3 84 30.4 C114 26.3 142 24.4 166 24.3"
        stroke="#94A3B8"
        strokeOpacity="0.55"
        strokeWidth="0.7"
        strokeLinecap="round"
      />

      {/*
       * 9. Панорамный обзорный иллюминатор: линза бронестекла по обводу носа.
       *
       * Всё содержимое обрезается контуром корпуса (`hull-clip`), поэтому даже
       * доля пикселя блика или шпангоута не «вылезет» за обшивку. Порядок слоёв:
       * тёмный шов-прокладка (стекло утоплено в силовой набор) → заливка
       * затемнённого бронестекла → диагональный блик → металлический шпангоут.
       * Никакого интерьера и экипажа внутри нет: за стеклом — только глубокий
       * космос, поэтому линза читается как отражение неба.
       */}
      <g clipPath="url(#trimaxion-flight-hull-clip)">
        <path
          d={WINDOW_PATH}
          fill="none"
          stroke="#0B1220"
          strokeOpacity="0.55"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d={WINDOW_PATH} fill="url(#trimaxion-flight-window)" />
        {/* Узкий диагональный блик: единственное «стеклянное» доказательство */}
        <g clipPath="url(#trimaxion-flight-window-clip)">
          <path
            d="M29.6 27.6 L37.6 25.8 L33 55.8 L25.2 57.6 Z"
            fill="url(#trimaxion-flight-window-sheen)"
          />
        </g>
        <path
          d={WINDOW_PATH}
          fill="none"
          stroke="url(#trimaxion-flight-window-frame)"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      </g>

      {/*
       * 10. Ближний двигатель: спарка читается как пара в 3/4. Дальняя гондола
       * уже нарисована ПОД корпусом (см. пункт 1) и частично уходит за контур
       * верхней спины, ближняя лежит поверх кормовой плиты. Оси сопел стоят
       * рядом по горизонтали (44.5 и 52.5), поэтому шлейфы идут почти
       * параллельно, но в разных плоскостях по глубине.
       */}
      <Nozzle mirrored offsetX={NEAR_NOZZLE_OFFSET_X} offsetY={NEAR_NOZZLE_OFFSET_Y} />

      {/* 11. Ядро блика: сюда «перетекает» далёкая звезда при подходе */}
      <ellipse
        cx="118"
        cy="48"
        rx="26"
        ry="8"
        fill="url(#trimaxion-flight-core)"
        className="trimaxion-core"
      />
    </svg>
  );
}
