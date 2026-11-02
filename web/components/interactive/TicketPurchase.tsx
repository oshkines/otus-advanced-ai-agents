"use client";

import { useState, type ReactElement } from "react";

import { BlurValidatedForm, type PassengerValues } from "@/components/interactive/BlurValidatedForm";
import { useOptimisticSteps } from "@/components/interactive/OptimisticAction";
import { cn } from "@/lib/cn";
import { CAR_TYPE_LABEL, type MockTrainOffer } from "@/lib/mock/rzhd";

const BUY_STEPS = ["Проверяю свободные места…", "Бронирую…", "Подтверждаю…"] as const;
const BUY_SUCCESS = "Билет забронирован (демо). Реальный заказ появится в Phase 6.";
const BUY_OFFLINE = "Нет сети: бронь не отправлена. Данные формы сохранены.";

export interface TicketPurchaseProps {
  readonly offer: MockTrainOffer;
}

/**
 * Покупка билета: раскрывает форму пассажира inline (US-RZ-04) и запускает
 * оптимистичный сценарий брони. Реальный вызов `rzhd_watcher` — Phase 6.
 */
export function TicketPurchase({ offer }: TicketPurchaseProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const { state, visibleSteps, message, run } = useOptimisticSteps(
    BUY_STEPS,
    BUY_SUCCESS,
    BUY_OFFLINE,
  );
  const isPending = state === "pending";
  const soldOut = offer.seats <= 0;

  const handleSubmit = (_values: PassengerValues): void => {
    run();
  };

  return (
    <div data-testid={`ticket-${offer.id}`} data-state={state} className="w-full">
      <button
        type="button"
        data-testid={`ticket-buy-${offer.id}`}
        disabled={soldOut}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          soldOut
            ? "cursor-not-allowed border-border bg-canvas/60 text-idle"
            : "border-success/60 bg-success/20 text-success-soft hover:border-success-soft hover:bg-success/30",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", soldOut ? "bg-idle" : "bg-success-soft")}
        />
        {soldOut ? "Мест нет" : "Купить билет"}
      </button>

      {isOpen ? (
        <BlurValidatedForm
          defaultDate={offer.date}
          status={state}
          statusMessage={message}
          isBusy={isPending}
          onSubmit={handleSubmit}
        />
      ) : null}

      {isPending && visibleSteps.length > 0 ? (
        <ol
          aria-live="polite"
          data-testid={`ticket-${offer.id}-steps`}
          className="mt-1 space-y-0.5 font-mono text-[10px] leading-4 text-muted"
        >
          {visibleSteps.map((step) => (
            <li key={step}>▸ {step}</li>
          ))}
        </ol>
      ) : null}

      <p className="mt-1 font-mono text-[10px] leading-4 text-muted">
        {offer.route} · {offer.date} · {CAR_TYPE_LABEL[offer.carType]}
      </p>
    </div>
  );
}
