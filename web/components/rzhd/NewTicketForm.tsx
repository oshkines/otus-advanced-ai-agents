"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactElement } from "react";

import { Pressable } from "@/components/ui/Pressable";
import { createRzhdTicket, describeApiFailure } from "@/lib/api/client";
import type { CarType, RzhdTicketCreatePayload } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { CAR_TYPE_LABEL, HOLIDAY_WINDOW } from "@/lib/mock/rzhd";

const INPUT_CLASS =
  "mt-1 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 " +
  "disabled:cursor-progress disabled:opacity-60";

const CAR_TYPES: ReadonlyArray<{ readonly value: CarType; readonly label: string }> = [
  { value: "coupe", label: CAR_TYPE_LABEL.coupe },
  { value: "platzkart", label: CAR_TYPE_LABEL.platzkart },
  { value: "sv", label: CAR_TYPE_LABEL.sv },
];

type FormStatus = "idle" | "pending" | "success" | "error";

/** Число из поля ввода: пусто/мусор → `null` (поле не отправляется). */
function parseNumber(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (normalized.length === 0) {
    return null;
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * `POST /api/v1/rzhd/tickets` — добавить наблюдаемый рейс.
 *
 * Бэкенд делает UPSERT по параметрам предложения, поэтому повторный опрос
 * вотчера не создаёт дубли; дата по умолчанию — начало окна каникул.
 */
export function NewTicketForm(): ReactElement {
  const router = useRouter();
  const [from, setFrom] = useState("Санкт-Петербург");
  const [to, setTo] = useState("Москва");
  const [travelDate, setTravelDate] = useState<string>(HOLIDAY_WINDOW.outbound);
  const [trainNumber, setTrainNumber] = useState("");
  const [carType, setCarType] = useState<CarType>("coupe");
  const [seats, setSeats] = useState("0");
  const [price, setPrice] = useState("");
  const [bookingUrl, setBookingUrl] = useState("");
  const [status, setStatus] = useState<FormStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const isPending = status === "pending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (from.trim().length === 0 || to.trim().length === 0) {
      setStatus("error");
      setMessage("Укажите направление: города отправления и прибытия.");
      return;
    }
    if (travelDate.trim().length === 0) {
      setStatus("error");
      setMessage("Укажите дату поездки.");
      return;
    }

    setStatus("pending");
    setMessage(null);

    const seatsValue = parseNumber(seats);
    const priceValue = parseNumber(price);
    const trimmedBookingUrl = bookingUrl.trim();
    const payload: RzhdTicketCreatePayload = {
      direction_from: from.trim(),
      direction_to: to.trim(),
      travel_date: travelDate,
      train_number: trainNumber.trim(),
      car_type: carType,
      seats_available: seatsValue === null || seatsValue < 0 ? 0 : Math.round(seatsValue),
      ...(priceValue !== null && priceValue >= 0 ? { price_rub: priceValue } : {}),
      ...(trimmedBookingUrl.length > 0 ? { booking_url: trimmedBookingUrl } : {}),
    };

    const response = await createRzhdTicket(payload);
    if (!response.ok) {
      setStatus("error");
      setMessage(describeApiFailure(response.error));
      return;
    }

    setStatus("success");
    setMessage(
      `Рейс #${response.data.id}: ${response.data.direction_from} → ${response.data.direction_to}, ` +
        `${response.data.travel_date}, мест: ${response.data.seats_available}.`,
    );
    setTrainNumber("");
    setPrice("");
    setBookingUrl("");
    router.refresh();
  }

  return (
    <form
      data-testid="new-ticket-form"
      data-state={status}
      noValidate
      onSubmit={handleSubmit}
      className="mt-2 rounded-bento border border-border bg-canvas/60 p-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        POST /api/v1/rzhd/tickets
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="new-ticket-from" className="block text-[11px] leading-4 text-muted">
            Откуда
          </label>
          <input
            id="new-ticket-from"
            data-testid="new-ticket-from"
            type="text"
            value={from}
            disabled={isPending}
            onChange={(event) => setFrom(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="new-ticket-to" className="block text-[11px] leading-4 text-muted">
            Куда
          </label>
          <input
            id="new-ticket-to"
            data-testid="new-ticket-to"
            type="text"
            value={to}
            disabled={isPending}
            onChange={(event) => setTo(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="new-ticket-date" className="block text-[11px] leading-4 text-muted">
            Дата поездки
          </label>
          <input
            id="new-ticket-date"
            data-testid="new-ticket-date"
            type="date"
            value={travelDate}
            min={HOLIDAY_WINDOW.outbound}
            max={HOLIDAY_WINDOW.inbound}
            disabled={isPending}
            onChange={(event) => setTravelDate(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
        <div>
          <label htmlFor="new-ticket-train" className="block text-[11px] leading-4 text-muted">
            Поезд
          </label>
          <input
            id="new-ticket-train"
            data-testid="new-ticket-train"
            type="text"
            value={trainNumber}
            disabled={isPending}
            placeholder="016А"
            onChange={(event) => setTrainNumber(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
      </div>


      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="new-ticket-car" className="block text-[11px] leading-4 text-muted">
            Тип вагона
          </label>
          <select
            id="new-ticket-car"
            data-testid="new-ticket-car"
            value={carType}
            disabled={isPending}
            onChange={(event) => setCarType(event.target.value as CarType)}
            className={INPUT_CLASS}
          >
            {CAR_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="new-ticket-seats" className="block text-[11px] leading-4 text-muted">
            Мест доступно
          </label>
          <input
            id="new-ticket-seats"
            data-testid="new-ticket-seats"
            type="number"
            min={0}
            value={seats}
            disabled={isPending}
            onChange={(event) => setSeats(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
        <div>
          <label htmlFor="new-ticket-price" className="block text-[11px] leading-4 text-muted">
            Цена, ₽
          </label>
          <input
            id="new-ticket-price"
            data-testid="new-ticket-price"
            type="number"
            min={0}
            step="0.01"
            value={price}
            disabled={isPending}
            placeholder="4820"
            onChange={(event) => setPrice(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
        <div>
          <label htmlFor="new-ticket-url" className="block text-[11px] leading-4 text-muted">
            Ссылка на покупку
          </label>
          <input
            id="new-ticket-url"
            data-testid="new-ticket-url"
            type="url"
            value={bookingUrl}
            disabled={isPending}
            placeholder="https://ticket.rzd.ru/order/1"
            onChange={(event) => setBookingUrl(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pressable
          type="submit"
          data-testid="new-ticket-submit"
          disabled={isPending}
          aria-busy={isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-control border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors",
            "hover:border-primary hover:bg-primary/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            "disabled:cursor-progress disabled:opacity-60",
          )}
        >
          {isPending ? "Сохраняю…" : "Добавить рейс"}
        </Pressable>
        <span className="text-[10px] leading-4 text-muted">
          UPSERT по направлению, дате, поезду и вагону
        </span>
      </div>

      <p
        data-testid="new-ticket-status"
        role={status === "error" ? "alert" : "status"}
        aria-live="polite"
        className={cn(
          "mt-2 min-h-4 text-[10px] leading-4",
          status === "error"
            ? "text-danger"
            : status === "success"
              ? "text-success-soft"
              : "text-muted",
        )}
      >
        {message ?? ""}
      </p>
    </form>
  );
}

