"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";

import type { OptimisticState } from "@/components/interactive/OptimisticAction";
import { cn } from "@/lib/cn";
import { HOLIDAY_WINDOW } from "@/lib/mock/rzhd";

export const NAME_ERROR = "Имя пассажира: минимум 2 символа, только буквы, пробел или дефис.";
export const DATE_REQUIRED_ERROR = "Укажите дату поездки.";
export const DATE_WINDOW_ERROR = `Мониторинг настроен на каникулы ${HOLIDAY_WINDOW.label}.`;
export const FORM_INVALID_MESSAGE = "Проверьте выделенные поля.";

export interface PassengerValues {
  readonly name: string;
  readonly date: string;
}

export interface BlurValidatedFormProps {
  readonly defaultDate: string;
  readonly status: OptimisticState;
  readonly statusMessage: string | null;
  readonly isBusy: boolean;
  readonly onSubmit: (values: PassengerValues) => void;
}

/** Буквы любого алфавита, пробел и дефис: «Иван Петров», «Анна-Мария», «Ivan Petrov». */
const NAME_PATTERN = /^[\p{L}][\p{L}\s-]*$/u;

function validateName(raw: string): string | null {
  const value = raw.trim();
  if (value.length < 2 || !NAME_PATTERN.test(value)) {
    return NAME_ERROR;
  }
  return null;
}

function validateDate(raw: string): string | null {
  if (raw.length === 0) {
    return DATE_REQUIRED_ERROR;
  }
  // ISO-даты (YYYY-MM-DD) сравниваются лексикографически корректно.
  if (raw < HOLIDAY_WINDOW.outbound || raw > HOLIDAY_WINDOW.inbound) {
    return DATE_WINDOW_ERROR;
  }
  return null;
}

type FieldName = "name" | "date";

/**
 * Форма пассажира с валидацией по `blur` (PRD_CHALLENGE.md §7.1).
 *
 * Ключевые правила: значение никогда не сбрасывается, ошибка появляется inline,
 * фокус не захватывается на blur, Escape скрывает подсказку, но не очищает поле.
 */
export function BlurValidatedForm({
  defaultDate,
  status,
  statusMessage,
  isBusy,
  onSubmit,
}: BlurValidatedFormProps): ReactElement {
  const uid = useId();
  const nameErrorId = `${uid}-name-error`;
  const dateErrorId = `${uid}-date-error`;

  const [name, setName] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [touched, setTouched] = useState<Readonly<Record<FieldName, boolean>>>({
    name: false,
    date: false,
  });
  const [suppressed, setSuppressed] = useState<Readonly<Record<FieldName, boolean>>>({
    name: false,
    date: false,
  });
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);

  // Форма открывается по клику пользователя: фокус в первое поле — ожидаемое поведение.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const nameError = validateName(name);
  const dateError = validateDate(date);
  const showNameError = touched.name && !suppressed.name && nameError !== null;
  const showDateError = touched.date && !suppressed.date && dateError !== null;

  const markTouched = useCallback((field: FieldName): void => {
    setTouched((current) => ({ ...current, [field]: true }));
    setSuppressed((current) => ({ ...current, [field]: false }));
  }, []);

  const handleEscape = (field: FieldName) => (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    // Скрываем подсказку, но значение остаётся: повторный blur покажет ошибку снова.
    setSuppressed((current) => ({ ...current, [field]: true }));
    setLocalMessage(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setTouched({ name: true, date: true });
    setSuppressed({ name: false, date: false });

    if (nameError !== null || dateError !== null) {
      setLocalMessage(FORM_INVALID_MESSAGE);
      const target = nameError !== null ? nameRef.current : dateRef.current;
      target?.focus();
      return;
    }

    setLocalMessage(null);
    onSubmit({ name: name.trim(), date });
  };

  const message = localMessage ?? statusMessage;
  const messageIsError = localMessage !== null || status === "error";
  const messageIsSuccess = !messageIsError && status === "success";

  return (
    <form
      data-testid="passenger-form"
      data-state={status}
      noValidate
      onSubmit={handleSubmit}
      className="mt-2 rounded-bento border border-border bg-canvas/60 p-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        Оформление · пассажир
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-name`} className="block text-[11px] leading-4 text-muted">
            Имя пассажира
          </label>
          <input
            id={`${uid}-name`}
            ref={nameRef}
            data-testid="passenger-name"
            type="text"
            value={name}
            autoComplete="name"
            spellCheck={false}
            placeholder="Иван Петров"
            disabled={isBusy}
            aria-invalid={showNameError}
            aria-describedby={showNameError ? nameErrorId : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setLocalMessage(null);
            }}
            onBlur={() => markTouched("name")}
            onKeyDown={handleEscape("name")}
            className={cn(
              "mt-1 w-full rounded-control border bg-surface px-2.5 py-1.5 text-sm text-ink",
              "placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              "disabled:cursor-progress disabled:opacity-60",
              showNameError ? "border-danger" : "border-border",
            )}
          />
          <p
            id={nameErrorId}
            data-testid="passenger-name-error"
            className="mt-1 min-h-4 text-[10px] leading-4 text-danger"
          >
            {showNameError ? nameError : ""}
          </p>
        </div>

        <div>
          <label htmlFor={`${uid}-date`} className="block text-[11px] leading-4 text-muted">
            Дата поездки
          </label>
          <input
            id={`${uid}-date`}
            ref={dateRef}
            data-testid="passenger-date"
            type="date"
            value={date}
            min={HOLIDAY_WINDOW.outbound}
            max={HOLIDAY_WINDOW.inbound}
            disabled={isBusy}
            aria-invalid={showDateError}
            aria-describedby={showDateError ? dateErrorId : undefined}
            onChange={(event) => {
              setDate(event.target.value);
              setLocalMessage(null);
            }}
            onBlur={() => markTouched("date")}
            onKeyDown={handleEscape("date")}
            className={cn(
              "mt-1 w-full rounded-control border bg-surface px-2.5 py-1.5 text-sm text-ink",
              "font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              "disabled:cursor-progress disabled:opacity-60",
              showDateError ? "border-danger" : "border-border",
            )}
          />
          <p
            id={dateErrorId}
            data-testid="passenger-date-error"
            className="mt-1 min-h-4 text-[10px] leading-4 text-danger"
          >
            {showDateError ? dateError : ""}
          </p>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="passenger-submit"
          disabled={isBusy}
          aria-busy={isBusy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-control border border-success/60 bg-success/20 px-3 py-1.5 text-xs font-semibold text-success-soft transition-colors",
            "hover:border-success-soft hover:bg-success/30",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            "disabled:cursor-progress disabled:opacity-60",
          )}
        >
          {isBusy ? "Бронирую…" : status === "error" ? "Повторить" : "Забронировать"}
        </button>
        <span className="text-[10px] leading-4 text-muted">
          Демо-режим: реальная бронь появится в Phase 6.
        </span>
      </div>

      <p
        data-testid="passenger-form-status"
        role={messageIsError ? "alert" : "status"}
        aria-live="polite"
        className={cn(
          "mt-2 min-h-4 text-[10px] leading-4",
          messageIsError ? "text-danger" : messageIsSuccess ? "text-success-soft" : "text-muted",
        )}
      >
        {message ?? ""}
      </p>
    </form>
  );
}

