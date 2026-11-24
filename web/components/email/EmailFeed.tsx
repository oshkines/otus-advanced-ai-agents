"use client";

import { useId, useState, type ReactElement } from "react";

import type { AiCategory, EmailItem, EmailStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";

/** Подписи категорий ИИ: те же пять значений, что в `docs/api_spec.md` §3.6. */
const CATEGORY_LABEL: Readonly<Record<AiCategory, string>> = {
  WHITELIST: "whitelist",
  CRITICAL: "критично",
  VACANCY: "вакансия",
  SPAM_VALUABLE: "полезный спам",
  SPAM: "спам",
};

const CATEGORY_TONE: Readonly<Record<AiCategory, string>> = {
  WHITELIST: "border-primary/50 bg-primary/10 text-primary",
  CRITICAL: "border-danger/50 bg-danger/10 text-danger",
  VACANCY: "border-ok/50 bg-ok/10 text-ok",
  SPAM_VALUABLE: "border-warn/50 bg-warn/10 text-warn",
  SPAM: "border-line bg-canvas/60 text-muted",
};

const STATUS_LABEL: Readonly<Record<EmailStatus, string>> = {
  new: "новое",
  classified: "классифицировано",
  notified: "уведомлено",
  ignored: "в игноре",
  deleted: "в архиве / спам",
  error: "ошибка",
};

export interface EmailFeedProps {
  readonly emails: readonly EmailItem[];
  readonly emptyText?: string;
}

/**
 * Лента писем из `GET /api/v1/emails` (таблица `emails` в PostgreSQL).
 *
 * Свёрнутая строка — тема, отправитель, бейдж категории, выжимка `ai_summary`,
 * дата и папка. Клик раскрывает детали прямо в карточке: полную выжимку,
 * Message-ID, модель ИИ, статус, spam-поля и время обработки. Тело письма
 * в БД не хранится (IMAP-сниппет уходит в LLM), поэтому «полный текст»
 * ограничен выжимкой — это честно сказано в подвале деталей.
 */
export function EmailFeed({
  emails,
  emptyText = "В таблице emails пока нет записей: письма появятся после первого опроса ящика.",
}: EmailFeedProps): ReactElement {
  const [openId, setOpenId] = useState<number | null>(null);
  const baseId = useId();

  if (emails.length === 0) {
    return <p className="text-sm text-muted">{emptyText}</p>;
  }

  return (
    <ul className="divide-y divide-line/70">
      {emails.map((email) => {
        const open = openId === email.id;
        const panelId = `${baseId}-email-${email.id}`;
        return (
          <li key={email.id} className="py-1">
            <button
              type="button"
              data-testid={`email-row-${email.id}`}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                setOpenId(open ? null : email.id);
              }}
              className={cn(
                "flex w-full flex-col gap-2 rounded-control-sm px-1 py-2 text-left transition-colors hover:bg-surface-hover",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {email.subject.length > 0 ? email.subject : "(без темы)"}
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                  {senderText(email)} · {formatTimestamp(email.created_at)}
                </p>
                <p
                  className={cn(
                    "mt-1 text-xs text-muted",
                    open ? "whitespace-pre-wrap" : "line-clamp-2",
                  )}
                >
                  {email.ai_summary ?? email.error_text ?? "Выжимка ИИ ещё не готова."}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted/80">
                  папка: {email.folder_name ?? "—"} · статус: {STATUS_LABEL[email.status]} ·{" "}
                  {open ? "свернуть" : "подробнее"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {email.category === null ? (
                  <span className="rounded-full border border-line bg-canvas/60 px-2 py-0.5 text-[10px] text-muted">
                    без категории
                  </span>
                ) : (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      CATEGORY_TONE[email.category],
                    )}
                  >
                    {CATEGORY_LABEL[email.category]}
                  </span>
                )}
                {email.priority === null ? null : (
                  <span className="rounded-full border border-line bg-canvas/60 px-2 py-0.5 font-mono text-[10px] text-muted">
                    {email.priority}
                  </span>
                )}
              </div>
            </button>

            {open ? <EmailDetails id={panelId} email={email} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Раскрытые детали письма: всё, что реально лежит в таблице `emails`. */
function EmailDetails({
  id,
  email,
}: {
  readonly id: string;
  readonly email: EmailItem;
}): ReactElement {
  return (
    <div
      id={id}
      data-testid={`email-details-${email.id}`}
      className="mt-1 mb-2 rounded-control-sm border border-line/70 bg-canvas/60 p-3"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        Детали письма
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <DetailRow label="Отправитель" value={senderText(email)} />
        <DetailRow label="Получено" value={formatTimestamp(email.received_at)} />
        <DetailRow
          label="Обработано"
          value={email.processed_at === null ? "—" : formatTimestamp(email.processed_at)}
        />
        <DetailRow label="Записано в БД" value={formatTimestamp(email.created_at)} />
        <DetailRow
          label="Папка"
          value={email.folder_name ?? (email.folder_id === null ? "—" : `id ${email.folder_id}`)}
        />
        <DetailRow label="Message-ID" value={email.message_id ?? email.external_id} />
        <DetailRow label="Модель ИИ" value={email.ai_model ?? "—"} />
        <DetailRow label="Статус" value={STATUS_LABEL[email.status]} />
        <DetailRow label="Категория" value={email.category ?? "—"} />
        <DetailRow label="Приоритет" value={email.priority ?? "—"} />
        <DetailRow label="Spam tag" value={email.spam_tag ?? "—"} />
        <DetailRow
          label="Флаги"
          value={[
            email.is_seen ? "прочитано" : "не прочитано",
            email.is_deleted ? "удалено" : "в ящике",
          ].join(" · ")}
        />
      </dl>

      <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        Выжимка ИИ
      </p>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink">
        {email.ai_summary ?? "Выжимка отсутствует: письмо ещё не прошло классификацию."}
      </p>

      {email.spam_url === null ? null : (
        <a
          href={email.spam_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block max-w-full truncate font-mono text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {email.spam_url}
        </a>
      )}

      {email.error_text === null ? null : (
        <p className="mt-1 text-[11px] text-danger">error: {email.error_text}</p>
      )}

      <p className="mt-2 text-[10px] leading-4 text-muted">
        Тело письма в PostgreSQL не хранится: в emails остаются тема, выжимка ИИ и
        метаданные обработки, полный текст доступен только в почтовом ящике.
      </p>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.08em] text-muted/80">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** `Имя <адрес>` с откатом на один адрес, если имя не пришло. */
function senderText(email: EmailItem): string {
  const name = email.sender_name.trim();
  const address = email.sender.trim();
  if (name.length === 0) {
    return address.length === 0 ? "—" : address;
  }
  return address.length === 0 ? name : `${name} <${address}>`;
}
