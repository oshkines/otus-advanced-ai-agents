import Link from "next/link";
import type { ReactElement } from "react";

import { ClassifyPreviewForm } from "@/components/ai/ClassifyPreviewForm";
import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { MailFolderChips } from "@/components/cards/MailFolderChips";
import { EmailFeed } from "@/components/email/EmailFeed";
import { MailFoldersSyncButton } from "@/components/email/MailFoldersSyncButton";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { ApiStatusBadge } from "@/components/states/ApiStatusBadge";
import {
  describeApiFailure,
  fetchDashboardSummary,
  fetchEmails,
  fetchMailFolders,
  getApiBaseUrl,
} from "@/lib/api/client";
import type { AiCategory, EmailStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNumber, formatTimestamp } from "@/lib/format";
import { describeSchedule, findSection } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

/** Размер ленты: `GET /emails?limit=20` — свежие письма без пагинации. */
const EMAIL_FEED_LIMIT = 20;

const EMAIL_STATUSES: readonly EmailStatus[] = [
  "new",
  "classified",
  "notified",
  "ignored",
  "deleted",
  "error",
];

const EMAIL_CATEGORIES: readonly AiCategory[] = [
  "WHITELIST",
  "CRITICAL",
  "VACANCY",
  "SPAM_VALUABLE",
  "SPAM",
];

interface EmailPageProps {
  /** Фильтры ленты задаются URL: `?status=new`, `?category=VACANCY`. */
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Первое значение query-параметра (Next отдаёт массив при повторах). */
function readParam(
  params: Readonly<Record<string, string | string[] | undefined>>,
  key: string,
): string | null {
  const value = params[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0] ?? null;
  }
  return null;
}

/** Статус из URL: неизвестное значение игнорируется, а не роняет страницу. */
function parseEmailStatus(value: string | null): EmailStatus | null {
  return EMAIL_STATUSES.find((status) => status === value) ?? null;
}

/** Категория из URL: тот же принцип — только значения контракта §3.6. */
function parseEmailCategory(value: string | null): AiCategory | null {
  return EMAIL_CATEGORIES.find((category) => category === value) ?? null;
}

/**
 * Канал Email: живые счётчики `dashboard/summary`, папки `mail/folders` и
 * лента писем из PostgreSQL (`GET /api/v1/emails`, таблица `emails`).
 *
 * Счётчики вверху работают фильтрами ленты: клик ведёт на `/email?status=new`
 * или `/email?status=classified`, «Всего писем» сбрасывает фильтр. Данные
 * берутся из БД без MOCK-подмены: при недоступном API видна причина сбоя.
 */
export default async function EmailPage({ searchParams }: EmailPageProps): Promise<ReactElement> {
  const params = (await searchParams) ?? {};
  const statusFilter = parseEmailStatus(readParam(params, "status"));
  const categoryFilter = parseEmailCategory(readParam(params, "category"));

  const [snapshot, dashboardResult, foldersResult, emailsResult] = await Promise.all([
    loadDashboardSnapshot(),
    fetchDashboardSummary(),
    fetchMailFolders(),
    fetchEmails({
      limit: EMAIL_FEED_LIMIT,
      status: statusFilter ?? undefined,
      category: categoryFilter ?? undefined,
    }),
  ]);

  const section = findSection(snapshot.nav, "email");
  const mail = dashboardResult.ok ? dashboardResult.data.mail : null;
  const spam = dashboardResult.ok ? dashboardResult.data.valuable_spam : null;
  const folders = foldersResult.ok ? foldersResult.data : null;
  const emails = emailsResult.ok ? emailsResult.data.items : [];

  const apiOnline = dashboardResult.ok && foldersResult.ok && emailsResult.ok;
  const apiDetail = dashboardResult.ok
    ? `${getApiBaseUrl()} · ${dashboardResult.latencyMs} мс · лента: ${
        emailsResult.ok ? emailsResult.data.total : "—"
      }`
    : dashboardResult.error.kind === "offline"
      ? getApiBaseUrl()
      : describeApiFailure(dashboardResult.error);

  /* Расписание берём из конфига: у канала свой cron (email_watcher — каждые 10 мин). */
  const schedule = section?.workers.find((worker) => worker.schedule !== null)?.schedule ?? null;
  const scheduleText = describeSchedule(schedule);
  const feedFiltered = statusFilter !== null || categoryFilter !== null;

  return (
    <>
      <SectionHeader
        section={section}
        generatedAtIso={snapshot.generatedAtIso}
        title="Email"
        description="Письма и папки ящика oshkines@mail.ru: живые счётчики PostgreSQL и AI-классификация"
        banner={<ApiStatusBadge online={apiOnline} detail={apiDetail} />}
      />

      <BentoGrid>
        <BentoCard
          title="Всего писем"
          subtitle={feedFiltered ? "клик — сбросить фильтр" : "вся лента · таблица emails"}
          href="/email"
          className={cn(
            "col-span-6 md:col-span-6 lg:col-span-3",
            feedFiltered ? null : "border-primary/50",
          )}
          testId="email-total-card"
        >
          <p className="text-3xl font-semibold">
            {mail === null ? "—" : formatNumber(mail.emails_total)}
          </p>
          <p className="mt-1 text-xs text-muted">PostgreSQL · таблица emails</p>
        </BentoCard>

        <BentoCard
          title="Новые"
          subtitle="клик — фильтр ленты status=new"
          href="/email?status=new"
          className={cn(
            "col-span-6 md:col-span-6 lg:col-span-3",
            statusFilter === "new" && "border-warn/60",
          )}
          testId="email-actionable-card"
        >
          <p className="text-3xl font-semibold text-warn">
            {mail === null ? "—" : formatNumber(mail.emails_new)}
          </p>
          <p className="mt-1 text-xs text-muted">status = new · ждут разбора</p>
        </BentoCard>

        <BentoCard
          title="Классифицировано"
          subtitle="клик — фильтр ленты status=classified"
          href="/email?status=classified"
          className={cn(
            "col-span-6 md:col-span-6 lg:col-span-3",
            statusFilter === "classified" && "border-ok/60",
          )}
          testId="email-rejected-card"
        >
          <p className="text-3xl font-semibold text-ok">
            {mail === null ? "—" : formatNumber(mail.emails_classified)}
          </p>
          <p className="mt-1 text-xs text-muted">category + summary сохранены</p>
        </BentoCard>

        <BentoCard
          title="Папки ящика"
          subtitle={schedule === null ? "расписание: демон" : `cron ${schedule}`}
          className="col-span-12 md:col-span-6 lg:col-span-3"
          testId="email-folders-card"
        >
          <p className="text-3xl font-semibold text-primary">
            {folders === null ? "—" : folders.total}
          </p>
          <p className="mt-1 text-xs text-muted">IMAP-папок в PostgreSQL</p>
          <div className="mt-2">
            <Metric
              label="В наблюдении"
              value={mail === null ? "—" : String(mail.folders_watched)}
              mono
            />
            <Metric
              label="Последняя синхронизация"
              value={
                mail === null || mail.last_sync_at === null
                  ? "—"
                  : formatTimestamp(mail.last_sync_at)
              }
              mono
            />
            <Metric
              label="Расписание"
              value={schedule === null ? scheduleText : `${scheduleText} · ${schedule}`}
              mono
            />
          </div>
          <MailFoldersSyncButton className="mt-2" />
        </BentoCard>

        <BentoCard
          title="Тест AI-классификации"
          subtitle="POST /api/v1/ai/classify-preview · DeepSeek structured output"
          className="col-span-12 lg:col-span-7"
          testId="email-ai-card"
        >
          <ClassifyPreviewForm />
        </BentoCard>

        <BentoCard
          title="Полезный спам"
          subtitle="valuable_spam · top tags"
          className="col-span-12 lg:col-span-5"
          testId="email-spam-card"
        >
          {spam === null ? (
            <p className="text-sm text-muted">Сводка valuable_spam придёт с живым API.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-3">
                <p className="text-3xl font-semibold text-warn">{spam.total}</p>
                <p className="text-xs text-muted">за 7 дней: {spam.last_7_days}</p>
              </div>
              {spam.top_tags.length === 0 ? (
                <p className="mt-2 text-xs text-muted">Теги пока не накоплены.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {spam.top_tags.map((tag) => (
                    <li
                      key={tag.tag}
                      className="rounded-full border border-line bg-canvas/60 px-2 py-0.5 font-mono text-[10px] text-ink"
                    >
                      {tag.tag} · {tag.count}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="mt-3 divide-y divide-line/70">
                {spam.latest.map((item) => (
                  <li key={item.id} className="py-2">
                    <p className="truncate text-xs font-medium text-ink">{item.subject}</p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                      {item.sender} · {item.spam_tag ?? "без тега"}
                    </p>
                    <p className="mt-1 text-[11px] text-muted">{item.summary}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </BentoCard>

        <BentoCard
          title="Папки IMAP"
          subtitle={
            folders === null
              ? "mail/folders недоступен"
              : `GET /api/v1/mail/folders · ${folders.total}`
          }
          className="col-span-12"
          testId="email-folders-list-card"
        >
          <MailFolderChips folders={folders} className="max-h-64" />
        </BentoCard>

        <BentoCard
          title="Последние обработанные письма (PostgreSQL)"
          subtitle={
            emailsResult.ok
              ? `GET /api/v1/emails · ${emails.length} из ${emailsResult.data.total} · created_at DESC`
              : "GET /api/v1/emails · API недоступен"
          }
          className="col-span-12"
          testId="email-list-card"
        >
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="rounded-full border border-line bg-canvas/60 px-2 py-0.5 font-mono">
              фильтр: {statusFilter === null ? "все письма" : `status=${statusFilter}`}
              {categoryFilter === null ? "" : ` · category=${categoryFilter}`}
            </span>
            {feedFiltered ? (
              <Link
                href="/email"
                className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 font-semibold text-primary transition-colors hover:bg-primary/20"
              >
                сбросить фильтр
              </Link>
            ) : null}
            <span className="font-mono text-muted/80">limit={EMAIL_FEED_LIMIT}</span>
          </div>

          {emailsResult.ok ? (
            <EmailFeed
              emails={emails}
              emptyText={
                feedFiltered
                  ? "Под текущий фильтр писем нет: нажмите «сбросить фильтр» или смените статус."
                  : "В таблице emails пока нет записей: письма появятся после первого опроса ящика mail_worker."
              }
            />
          ) : (
            <p className="rounded-control-sm border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
              {describeApiFailure(emailsResult.error)}
            </p>
          )}
        </BentoCard>
      </BentoGrid>
    </>
  );
}
