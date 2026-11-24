import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { NewTicketForm } from "@/components/rzhd/NewTicketForm";
import { ApiStatusBadge } from "@/components/states/ApiStatusBadge";
import { describeApiFailure, fetchRzhdTickets, getApiBaseUrl } from "@/lib/api/client";
import type { CarType, RzhdTicket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { MOCK_TRAIN_OFFERS, type MockTrainOffer } from "@/lib/mock/rzhd";
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

/** Все типы вагонов API (`CarType`), а не только три из MOCK-модуля. */
const CAR_TYPE_TEXT: Readonly<Record<CarType, string>> = {
  coupe: "Купе",
  platzkart: "Плацкарт",
  sv: "СВ",
  sitting: "Сидячий",
  luxury: "Люкс",
};

const STATUS_TONE: Readonly<Record<RzhdTicket["status"], string>> = {
  watching: "border-warn/50 bg-warn/10 text-warn",
  available: "border-ok/50 bg-ok/10 text-ok",
  booked: "border-primary/50 bg-primary/10 text-primary",
  expired: "border-line bg-canvas/60 text-muted",
  cancelled: "border-danger/50 bg-danger/10 text-danger",
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
 *
 * Живые данные — `GET /api/v1/rzhd/tickets`, добавление рейса —
 * `POST /api/v1/rzhd/tickets` (UPSERT). При недоступном API показываются
 * MOCK-рейсы и статус `API offline / fallback`.
 */
export default async function RzhdPage(): Promise<ReactElement> {
  const [snapshot, listResult] = await Promise.all([
    loadDashboardSnapshot(),
    fetchRzhdTickets({ limit: 50 }),
  ]);

  const section = findSection(snapshot.nav, "rzhd");

  const worker = section?.workers[0] ?? null;
  const args = worker?.args ?? [];
  const from = argValue(args, "--from");
  const to = argValue(args, "--to");
  const carTypes = argValue(args, "--car-types");
  const purpose = argValue(args, "--purpose");

  const tickets = listResult.ok ? listResult.data.items : [];
  const total = listResult.ok ? listResult.data.total : MOCK_TRAIN_OFFERS.length;
  const totalSeats = listResult.ok
    ? tickets.reduce((sum, ticket) => sum + ticket.seats_available, 0)
    : MOCK_TRAIN_OFFERS.reduce((sum, offer) => sum + offer.seats, 0);
  const prices = listResult.ok
    ? tickets
        .map((ticket) => ticket.price_rub)
        .filter((price): price is number => price !== null)
    : MOCK_TRAIN_OFFERS.map((offer) => offer.priceRub);
  const minPrice = prices.length === 0 ? null : Math.min(...prices);

  const apiDetail = listResult.ok
    ? `${getApiBaseUrl()} · ${listResult.latencyMs} мс · ${listResult.data.total} рейсов`
    : listResult.error.kind === "offline"
      ? getApiBaseUrl()
      : describeApiFailure(listResult.error);

  return (
    <>
      <SectionHeader
        section={section}
        generatedAtIso={snapshot.generatedAtIso}
        title="РЖД"
        description="Свободные места, цены и типы вагонов на даты каникул Алфёровского вуза"
        banner={<ApiStatusBadge online={listResult.ok} detail={apiDetail} />}
      />

      <BentoGrid>
        <BentoCard
          title="Рейсов в мониторинге"
          className="col-span-6 md:col-span-4 lg:col-span-4"
          testId="rzhd-offers-card"
        >
          <p className="text-3xl font-semibold">{formatNumber(total)}</p>
          <p className="mt-1 text-xs text-muted">
            {listResult.ok ? "GET /api/v1/rzhd/tickets" : "MOCK fallback"}
          </p>
        </BentoCard>

        <BentoCard
          title="Свободных мест"
          className="col-span-6 md:col-span-4 lg:col-span-4"
          testId="rzhd-seats-card"
        >
          <p className="text-3xl font-semibold text-ok">{formatNumber(totalSeats)}</p>
          <p className="mt-1 text-xs text-muted">суммарно по всем типам вагонов</p>
        </BentoCard>

        <BentoCard
          title="Минимальная цена"
          className="col-span-12 md:col-span-4 lg:col-span-4"
          testId="rzhd-price-card"
        >
          <p className="text-3xl font-semibold">
            {minPrice === null ? "—" : `${formatNumber(minPrice)} ₽`}
          </p>
          <p className="mt-1 text-xs text-muted">самый дешёвый вариант из БД</p>
        </BentoCard>

        <BentoCard
          title="Параметры мониторинга"
          subtitle={worker?.id ?? "rzhd_watcher"}
          className="col-span-12 lg:col-span-4"
          testId="rzhd-params-card"
        >
          <Metric label="Направление" value={`${from ?? "—"} → ${to ?? "—"}`} mono />
          <Metric label="Типы вагонов" value={carTypes ?? "—"} mono />
          <Metric label="Повод" value={purpose ?? "—"} mono />
          <Metric label="Cron" value={worker?.schedule ?? "—"} mono />
        </BentoCard>

        <BentoCard
          title="Новый рейс"
          subtitle="POST /api/v1/rzhd/tickets"
          className="col-span-12 lg:col-span-5"
          testId="rzhd-create-card"
        >
          <NewTicketForm />
        </BentoCard>

        <BentoCard
          title="Рейсы"
          subtitle={
            listResult.ok
              ? `${listResult.data.items.length} из ${listResult.data.total} · PostgreSQL`
              : "MOCK fallback"
          }
          className="col-span-12 lg:col-span-7"
          testId="rzhd-list-card"
        >
          {listResult.ok ? (
            tickets.length === 0 ? (
              <p className="text-sm text-muted">
                В таблице rzhd_tickets пока нет записей: добавьте рейс формой слева.
              </p>
            ) : (
              <ul className="divide-y divide-line/70">
                {tickets.map((ticket) => (
                  <li
                    key={ticket.id}
                    className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {ticket.direction_from} → {ticket.direction_to}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted">
                        {ticket.travel_date} · {ticket.train_number || "поезд ?"} ·{" "}
                        {CAR_TYPE_TEXT[ticket.car_type]}
                      </p>
                      {ticket.booking_url === null ? null : (
                        <a
                          href={ticket.booking_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block max-w-full truncate font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                        >
                          {ticket.booking_url}
                        </a>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-xs text-muted">
                        мест: <span className="font-mono text-ink">{ticket.seats_available}</span>
                      </span>
                      <span className="font-mono text-sm text-ink">
                        {ticket.price_rub === null ? "—" : `${formatNumber(ticket.price_rub)} ₽`}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                          STATUS_TONE[ticket.status],
                        )}
                      >
                        {ticket.status}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <p className="mb-2 text-[11px] text-muted">
                FastAPI недоступен: показаны MOCK-рейсы.
              </p>
              <ul className="divide-y divide-line/70">
                {MOCK_TRAIN_OFFERS.map((offer) => (
                  <li
                    key={offer.id}
                    className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{offer.route}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted">
                        {offer.date} · {offer.train} · {CAR_TYPE_TEXT[offer.carType]}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-xs text-muted">
                        мест: <span className="font-mono text-ink">{offer.seats}</span>
                      </span>
                      <span className="font-mono text-sm text-ink">
                        {formatNumber(offer.priceRub)} ₽
                      </span>
                      <span
                        className={cn("text-[11px] font-semibold", TREND_TONE[offer.trend])}
                      >
                        {TREND_LABEL[offer.trend]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </>
  );
}
