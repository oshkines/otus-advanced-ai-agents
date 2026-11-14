/**
 * MOCK: предложения РЖД для страницы `/rzhd`.
 * Предмет мониторинга: свободные места, цены и типы вагонов на даты каникул
 * Алфёровского вуза (см. CONTRACT.md, `workers[rzhd_watcher].args`).
 * Заменяется данными `agents/rzhd_watcher.py` после включения воркера (Phase 6).
 */
export type CarType = "coupe" | "platzkart" | "sv";

export interface MockTrainOffer {
  readonly id: string;
  readonly route: string;
  readonly date: string;
  readonly train: string;
  readonly carType: CarType;
  readonly seats: number;
  readonly priceRub: number;
  readonly trend: "up" | "down" | "flat";
}

export const CAR_TYPE_LABEL: Readonly<Record<CarType, string>> = {
  coupe: "Купе",
  platzkart: "Плацкарт",
  sv: "СВ",
};

/**
 * Окно каникул сына (Алфёровский университет) — единственный источник дат
 * для UI, countdown и валидации формы пассажира (PRD_CHALLENGE.md US-RZ-01/04/05).
 * После Phase 6 значения приходят из `rzhd_watcher`, а не из MOCK-модуля.
 */
export const HOLIDAY_WINDOW = {
  outbound: "2026-12-26",
  inbound: "2027-01-09",
  label: "26.12.2026 — 09.01.2027",
} as const;


export const MOCK_TRAIN_OFFERS: readonly MockTrainOffer[] = [
  {
    id: "rzd-001",
    route: "Санкт-Петербург → Москва",
    date: "2026-12-26",
    train: "016А «Аврора»",
    carType: "coupe",
    seats: 12,
    priceRub: 4820,
    trend: "down",
  },
  {
    id: "rzd-002",
    route: "Санкт-Петербург → Москва",
    date: "2026-12-26",
    train: "062А",
    carType: "platzkart",
    seats: 34,
    priceRub: 2650,
    trend: "flat",
  },
  {
    id: "rzd-003",
    route: "Москва → Санкт-Петербург",
    date: "2027-01-09",
    train: "004А «Экспресс»",
    carType: "sv",
    seats: 4,
    priceRub: 12400,
    trend: "up",
  },
  {
    id: "rzd-004",
    route: "Санкт-Петербург → Москва",
    date: "2027-01-08",
    train: "018А",
    carType: "coupe",
    seats: 7,
    priceRub: 5310,
    trend: "up",
  },
];
