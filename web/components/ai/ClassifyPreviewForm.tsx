"use client";

import { useState, type FormEvent, type ReactElement } from "react";

import { Pressable } from "@/components/ui/Pressable";
import {
  AI_TIMEOUT_MS,
  classifyPreview,
  describeApiFailure,
  getApiBaseUrl,
  type ApiFailure,
} from "@/lib/api/client";
import type { AiCategory, ClassifyPreviewResponse } from "@/lib/api/types";
import { cn } from "@/lib/cn";

const SAMPLE_SUBJECT = "Промокод SALE5000 — только сегодня";
const SAMPLE_SENDER = "promo@shop.ru";
const SAMPLE_TEXT =
  "Дарим промокод SALE5000 на 5000 ₽ при заказе от 3000 ₽. " +
  "Действует до воскресенья, подробности: https://shop.ru/promo";

const CATEGORY_LABEL: Readonly<Record<AiCategory, string>> = {
  WHITELIST: "белый список",
  CRITICAL: "критично",
  VACANCY: "вакансия",
  SPAM_VALUABLE: "полезный спам",
  SPAM: "спам",
};

const CATEGORY_TONE: Readonly<Record<AiCategory, string>> = {
  WHITELIST: "border-ok/50 bg-ok/10 text-ok",
  CRITICAL: "border-danger/50 bg-danger/10 text-danger",
  VACANCY: "border-primary/50 bg-primary/10 text-primary",
  SPAM_VALUABLE: "border-warn/50 bg-warn/10 text-warn",
  SPAM: "border-line bg-canvas/60 text-muted",
};

type FormStatus = "idle" | "pending" | "success" | "error";

/**
 * Интерактивный блок «Тест AI-классификации» (вкладка `/email`).
 *
 * Отправляет текст письма в `POST /api/v1/ai/classify-preview` и показывает
 * структурированный ответ LLM: `category`, `summary`, `spam_tag`, `spam_url`
 * (+ `priority`, `work_format` и телеметрию вызова). Ошибки сети/LLM
 * показываются текстом — форма не роняет страницу.
 */
export function ClassifyPreviewForm(): ReactElement {
  const [subject, setSubject] = useState(SAMPLE_SUBJECT);
  const [sender, setSender] = useState(SAMPLE_SENDER);
  const [text, setText] = useState(SAMPLE_TEXT);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [result, setResult] = useState<ClassifyPreviewResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const isPending = status === "pending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = text.trim();
    if (body.length === 0) {
      setLocalError("Введите текст письма: пустой запрос API отклонит (422).");
      return;
    }

    setLocalError(null);
    setFailure(null);
    setStatus("pending");

    const response = await classifyPreview({
      kind: "email",
      text: body,
      subject: subject.trim(),
      sender: sender.trim(),
      persist: true,
    });

    if (response.ok) {
      setResult(response.data);
      setStatus("success");
      return;
    }
    setResult(null);
    setFailure(response.error);
    setStatus("error");
  }

  const message = localError ?? (failure === null ? null : describeApiFailure(failure));

  return (
    <form
      data-testid="ai-classify-form"
      data-state={status}
      noValidate
      onSubmit={handleSubmit}
      className="mt-2 rounded-bento border border-border bg-canvas/60 p-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        POST /api/v1/ai/classify-preview
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="ai-classify-subject" className="block text-[11px] leading-4 text-muted">
            Тема письма
          </label>
          <input
            id="ai-classify-subject"
            data-testid="ai-classify-subject"
            type="text"
            value={subject}
            spellCheck={false}
            disabled={isPending}
            onChange={(event) => setSubject(event.target.value)}
            className="mt-1 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-progress disabled:opacity-60"
          />
        </div>
        <div>
          <label htmlFor="ai-classify-sender" className="block text-[11px] leading-4 text-muted">
            Отправитель
          </label>
          <input
            id="ai-classify-sender"
            data-testid="ai-classify-sender"
            type="text"
            value={sender}
            spellCheck={false}
            disabled={isPending}
            onChange={(event) => setSender(event.target.value)}
            className="mt-1 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-ink placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-progress disabled:opacity-60"
          />
        </div>
      </div>

      <label htmlFor="ai-classify-text" className="mt-2 block text-[11px] leading-4 text-muted">
        Текст письма
      </label>
      <textarea
        id="ai-classify-text"
        data-testid="ai-classify-text"
        value={text}
        rows={4}
        disabled={isPending}
        onChange={(event) => setText(event.target.value)}
        className="mt-1 w-full resize-y rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-idle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-progress disabled:opacity-60"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pressable
          type="submit"
          data-testid="ai-classify-submit"
          disabled={isPending}
          aria-busy={isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-control border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors",
            "hover:border-primary hover:bg-primary/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            "disabled:cursor-progress disabled:opacity-60",
          )}
        >
          {isPending ? "LLM думает…" : "Тест AI-классификации"}
        </Pressable>
        <span className="text-[10px] leading-4 text-muted">
          {getApiBaseUrl()} · таймаут {Math.round(AI_TIMEOUT_MS / 1000)} с · persist=true
        </span>
      </div>

      <p
        data-testid="ai-classify-status"
        role={message === null ? "status" : "alert"}
        aria-live="polite"
        className={cn(
          "mt-2 min-h-4 text-[10px] leading-4",
          message === null ? "text-muted" : "text-danger",
        )}
      >
        {message ?? (isPending ? "Отправляю письмо в каскад DeepSeek…" : "")}
      </p>

      {result === null ? null : (
        <div
          data-testid="ai-classify-result"
          data-category={result.classification.category}
          data-priority={result.classification.priority}
          className="mt-2 rounded-bento-inner border border-line bg-surface/80 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                CATEGORY_TONE[result.classification.category],
              )}
            >
              {result.classification.category} · {CATEGORY_LABEL[result.classification.category]}
            </span>
            <span className="font-mono text-[10px] text-muted">
              priority={result.classification.priority}
            </span>
            <span className="font-mono text-[10px] text-muted">
              {result.ai.used_model} · {result.ai.latency_ms} мс · попыток {result.ai.attempts}
            </span>
            {result.ai.fallback_used ? (
              <span className="text-[10px] font-semibold text-warn">fallback model</span>
            ) : null}
          </div>

          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted">summary</dt>
              <dd className="min-w-0 text-ink">
                {result.classification.summary.length > 0 ? result.classification.summary : "—"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted">spam_tag</dt>
              <dd className="min-w-0 font-mono text-ink">{result.classification.spam_tag ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted">spam_url</dt>
              <dd className="min-w-0 break-all">
                {result.classification.spam_url === null ? (
                  <span className="font-mono text-ink">—</span>
                ) : (
                  <a
                    href={result.classification.spam_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {result.classification.spam_url}
                  </a>
                )}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted">
                work_format
              </dt>
              <dd className="min-w-0 font-mono text-ink">
                {result.classification.work_format ?? "—"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted">persisted</dt>
              <dd className="min-w-0 break-all font-mono text-muted">
                email_id={result.persisted.email_id ?? "—"} · spam_id=
                {result.persisted.valuable_spam_id ?? "—"} · vacancy_id=
                {result.persisted.vacancy_id ?? "—"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </form>
  );
}

