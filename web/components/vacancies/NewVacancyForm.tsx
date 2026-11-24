"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactElement } from "react";

import { Pressable } from "@/components/ui/Pressable";
import { createVacancy, describeApiFailure } from "@/lib/api/client";
import type { VacancyCreatePayload, WorkFormat } from "@/lib/api/types";
import { cn } from "@/lib/cn";

const INPUT_CLASS =
  "mt-1 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 " +
  "disabled:cursor-progress disabled:opacity-60";

const WORK_FORMAT_OPTIONS: ReadonlyArray<{ readonly value: "" | WorkFormat; readonly label: string }> = [
  { value: "", label: "не указан" },
  { value: "remote", label: "remote" },
  { value: "hybrid", label: "hybrid" },
  { value: "office", label: "office" },
];

type FormStatus = "idle" | "pending" | "success" | "error";

/**
 * `POST /api/v1/vacancies` — добавить вакансию вручную.
 *
 * Бэкенд делает идемпотентный UPSERT по `source` + `external_id`:
 * повторная отправка того же заголовка вернёт 200 и существующую строку.
 */
export function NewVacancyForm(): ReactElement {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [source, setSource] = useState("manual");
  const [url, setUrl] = useState("");
  const [workFormat, setWorkFormat] = useState<"" | WorkFormat>("");
  const [status, setStatus] = useState<FormStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const isPending = status === "pending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (title.trim().length === 0) {
      setStatus("error");
      setMessage("Название вакансии обязательно (поле title).");
      return;
    }

    setStatus("pending");
    setMessage(null);

    const trimmedUrl = url.trim();
    const payload: VacancyCreatePayload = {
      source: source.trim().length > 0 ? source.trim() : "manual",
      title: title.trim(),
      company: company.trim(),
      ...(trimmedUrl.length > 0 ? { url: trimmedUrl } : {}),
      ...(workFormat === "" ? {} : { work_format: workFormat }),
    };

    const response = await createVacancy(payload);
    if (!response.ok) {
      setStatus("error");
      setMessage(describeApiFailure(response.error));
      return;
    }

    setStatus("success");
    setMessage(`Вакансия #${response.data.id} сохранена (${response.data.title}).`);
    setTitle("");
    setCompany("");
    setUrl("");
    router.refresh();
  }

  return (
    <form
      data-testid="new-vacancy-form"
      data-state={status}
      noValidate
      onSubmit={handleSubmit}
      className="mt-2 rounded-bento border border-border bg-canvas/60 p-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        POST /api/v1/vacancies
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="new-vacancy-title" className="block text-[11px] leading-4 text-muted">
            Название
          </label>
          <input
            id="new-vacancy-title"
            data-testid="new-vacancy-title"
            type="text"
            value={title}
            disabled={isPending}
            placeholder="C++ Developer (Middle)"
            onChange={(event) => setTitle(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="new-vacancy-company" className="block text-[11px] leading-4 text-muted">
            Компания
          </label>
          <input
            id="new-vacancy-company"
            data-testid="new-vacancy-company"
            type="text"
            value={company}
            disabled={isPending}
            placeholder="AlferSoft"
            onChange={(event) => setCompany(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="new-vacancy-source" className="block text-[11px] leading-4 text-muted">
            Источник
          </label>
          <input
            id="new-vacancy-source"
            data-testid="new-vacancy-source"
            type="text"
            value={source}
            disabled={isPending}
            onChange={(event) => setSource(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
        <div>
          <label htmlFor="new-vacancy-url" className="block text-[11px] leading-4 text-muted">
            Ссылка (http/https)
          </label>
          <input
            id="new-vacancy-url"
            data-testid="new-vacancy-url"
            type="url"
            value={url}
            disabled={isPending}
            placeholder="https://hh.ru/vacancy/42"
            onChange={(event) => setUrl(event.target.value)}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </div>
        <div>
          <label htmlFor="new-vacancy-format" className="block text-[11px] leading-4 text-muted">
            Формат работы
          </label>
          <select
            id="new-vacancy-format"
            data-testid="new-vacancy-format"
            value={workFormat}
            disabled={isPending}
            onChange={(event) => setWorkFormat(event.target.value as "" | WorkFormat)}
            className={INPUT_CLASS}
          >
            {WORK_FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pressable
          type="submit"
          data-testid="new-vacancy-submit"
          disabled={isPending}
          aria-busy={isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-control border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors",
            "hover:border-primary hover:bg-primary/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            "disabled:cursor-progress disabled:opacity-60",
          )}
        >
          {isPending ? "Сохраняю…" : "Добавить в PostgreSQL"}
        </Pressable>
        <span className="text-[10px] leading-4 text-muted">
          UPSERT по source + external_id; формат и игнор хранятся в raw.api
        </span>
      </div>

      <p
        data-testid="new-vacancy-status"
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

