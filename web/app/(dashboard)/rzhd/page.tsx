import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { cn } from "@/lib/cn";
import { CAR_TYPE_LABEL, MOCK_TRAIN_OFFERS, type MockTrainOffer } from "@/lib/mock/rzhd";
import { findSection } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

const TREND_LABEL: Readonly<Record<MockTrainOffer["trend"], string>> = {
  up: "цена растёт",
  down: "цена падает",
  flat: "цена стабильна",
};

const TREND_TONE: Readonly<Record<MockTrainOffer["trend"], string>> = {
  up: "text-danger",
  down: "text-ok",
  flat: "text-muted",
};

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value: string | undefined = args[index + 1];
  return value ?? null;
}

/**
 * Канал «РЖД»: свободные места, цены и типы вагонов на даты каникул
 * Алфёровского вуза (п.4.3 DISCUSS.md).
 */
export default async function RzhdPage(): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();
  const section = findSection(snapshot.nav, "rzhd");

  const worker = section?.workers[0] ?? null;
  const args = worker?.args ?? [];
  const from = argValue(args, "--from");
  const to = argValue(args, "--to");
  const carTypes = argValue(args, "--car-types");
  const purpose = argValue(args, "--purpose");

  const totalSeats = MOCK_TRAIN_OFFERS.reduce((sum, offer) => sum + offer.seats, 0);
  const minPrice = MOCK_TRAIN_OFFERS.reduce(
    (min, offer) => (offer.priceRub < min ? offer.priceRub : min),
    Number.POSITIVE_INFINITY,
  );

  return (
    <>
      <SectionHeader
        section={section}
        title="РЖД"
        description="Свободные места, цены и типы вагонов на даты каникул Алфёровского вуза"
      />

      <BentoGrid>
        <BentoCard
          title="Рейсов в мониторинге"
          className="col-span-6 md:col-span-4 lg:col-span-3"
          testId="rzhd-offers-card"
        >
          <p className="text-3xl font-semibold">{MOCK_TRAIN_OFFERS.length}</p>
          <p className="mt-1 text-xs text-muted">по выбранному направлению</p>
        </BentoCard>

        <BentoCard
          title="Свободных мест"
          className="col-span-6 md:col-span-4 lg:col-span-3"
          testId="rzhd-seats-card"
        >
          <p className="text-3xl font-semibold text-ok">{totalSeats}</p>
          <p className="mt-1 text-xs text-muted">суммарно по всем типам вагонов</p>
        </BentoCard>

        <BentoCard
          title="Минимальная цена"
          className="col-span-12 md:col-span-4 lg:col-span-3"
          testId="rzhd-price-card"
        >
          <p className="text-3xl font-semibold">
            {Number.isFinite(minPrice) ? `${minPrice.toLocaleString("ru-RU")} ₽` : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">самый дешёвый вариант</p>
        </BentoCard>

        <BentoCard
          title="Параметры мониторинга"
          subtitle={worker?.id ?? "rzhd_watcher"}
          className="col-span-12 lg:col-span-3"
          testId="rzhd-params-card"
        >
          <Metric label="Направление" value={`${from ?? "—"} → ${to ?? "—"}`} mono />
          <Metric label="Типы вагонов" value={carTypes ?? "—"} mono />
          <Metric label="Повод" value={purpose ?? "—"} mono />
          <Metric label="Cron" value={worker?.schedule ?? "—"} mono />
        </BentoCard>

        <BentoCard
          title="Рейсы"
          subtitle="дата · поезд · вагон · места · цена"
          className="col-span-12"
          testId="rzhd-list-card"
        >
          <ul className="divide-y divide-line/70">
            {MOCK_TRAIN_OFFERS.map((offer) => (
              <li
                key={offer.id}
                className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{offer.route}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted">
                    {offer.date} · {offer.train} · {CAR_TYPE_LABEL[offer.carType]}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted">
                    мест: <span className="font-mono text-ink">{offer.seats}</span>
                  </span>
                  <span className="font-mono text-sm text-ink">
                    {offer.priceRub.toLocaleString("ru-RU")} ₽
                  </span>
                  <span className={cn("text-[11px] font-semibold", TREND_TONE[offer.trend])}>
                    {TREND_LABEL[offer.trend]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </BentoCard>
      </BentoGrid>
    </>
  );
}
