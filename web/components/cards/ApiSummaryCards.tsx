import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { MailFolderChips } from "@/components/cards/MailFolderChips";
import type { DashboardSummary, MailFolderList } from "@/lib/api/types";
import { formatNumber, formatTimestamp } from "@/lib/format";

export interface ApiSummaryCardsProps {
  readonly dashboard: DashboardSummary | null;
  readonly folders: MailFolderList | null;
}

/**
 * Карточки живых данных FastAPI на обзоре.
 *
 * Источники: `GET /api/v1/dashboard/summary` (счётчики писем/вакансий/РЖД,
 * здоровье БД, лимиты ИИ) и `GET /api/v1/mail/folders` (реальные папки ящика
 * `oshkines@mail.ru` из PostgreSQL). При `null` карточка объясняет, что API
 * недоступен, и не роняет страницу.
 */
export function ApiSummaryCards({ dashboard, folders }: ApiSummaryCardsProps): ReactElement {
  return (
    <BentoGrid>
      <BentoCard
        title="Почтовый ящик"
        subtitle={
          folders === null ? "mail/folders недоступен" : `папок в PostgreSQL: ${folders.total}`
        }
        className="col-span-12 md:col-span-6 lg:col-span-4"
        testId="api-mail-card"
      >
        {dashboard === null ? (
          <p className="text-sm text-muted">
            GET /api/v1/dashboard/summary недоступен — используются MOCK-счётчики.
          </p>
        ) : (
          <>
            <Metric label="Аккаунтов" value={String(dashboard.mail.accounts)} />
            <Metric
              label="Папок синхронизировано"
              value={String(dashboard.mail.folders_synced)}
            />
            <Metric label="Папок в наблюдении" value={String(dashboard.mail.folders_watched)} />
            <Metric label="Писем всего" value={formatNumber(dashboard.mail.emails_total)} />
            <Metric label="Новых" value={formatNumber(dashboard.mail.emails_new)} tone="warn" />
            <Metric
              label="Классифицировано"
              value={formatNumber(dashboard.mail.emails_classified)}
              tone="ok"
            />
            <Metric
              label="Последняя синхронизация"
              value={
                dashboard.mail.last_sync_at === null
                  ? "—"
                  : formatTimestamp(dashboard.mail.last_sync_at)
              }
              mono
            />
          </>
        )}
      </BentoCard>

      <BentoCard
        title="Папки IMAP"
        subtitle={
          folders === null ? "fallback: список недоступен" : "GET /api/v1/mail/folders"
        }
        className="col-span-12 md:col-span-6 lg:col-span-8"
        testId="api-folders-card"
      >
        {folders === null ? (
          <p className="text-sm text-muted">
            Список папок появится, когда FastAPI и PostgreSQL будут доступны.
          </p>
        ) : (
          <MailFolderChips folders={folders} className="max-h-56" />
        )}
      </BentoCard>
      <BentoCard
        title="PostgreSQL и LLM"
        subtitle="database + ai из /dashboard/summary"
        className="col-span-12"
        testId="api-health-card"
      >
        {dashboard === null ? (
          <p className="text-sm text-muted">
            Данные о здоровье БД и лимитах ИИ приходят только с живым API.
          </p>
        ) : (
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Metric
                label="PostgreSQL"
                value={dashboard.database.status}
                tone={dashboard.database.status === "ok" ? "ok" : "danger"}
                mono
              />
              <Metric
                label="Задержка SELECT 1"
                value={
                  dashboard.database.latency_ms === null
                    ? "—"
                    : `${dashboard.database.latency_ms} мс`
                }
                mono
              />
              <Metric
                label="Пул (size/free)"
                value={
                  dashboard.database.pool_size === null || dashboard.database.pool_free === null
                    ? "—"
                    : `${dashboard.database.pool_size}/${dashboard.database.pool_free}`
                }
                mono
              />
              <Metric label="Target" value={dashboard.database.target ?? "—"} mono />
            </div>
            <div>
              <Metric
                label="Классификатор"
                value={dashboard.ai.classifier_model ?? "—"}
                mono
              />
              <Metric label="Fallback" value={dashboard.ai.fallback_model ?? "—"} mono />
              <Metric
                label="Бюджет токенов"
                value={dashboard.ai.max_tokens === null ? "—" : String(dashboard.ai.max_tokens)}
                mono
              />
              <Metric
                label="Инструкций активно"
                value={String(dashboard.ai.instructions_active)}
                mono
              />
            </div>
            <div>
              <Metric label="Вакансии (всего/активных)" value={`${dashboard.vacancies.total}/${dashboard.vacancies.active}`} mono />
              <Metric
                label="Полезный спам"
                value={`${dashboard.valuable_spam.total} (7 дней: ${dashboard.valuable_spam.last_7_days})`}
                mono
              />
              <Metric
                label="Ближайший рейс"
                value={dashboard.rzhd.nearest_travel_date ?? "—"}
                mono
              />
              <Metric
                label="Сгенерировано"
                value={formatTimestamp(dashboard.generated_at)}
                mono
              />
            </div>
          </div>
        )}
      </BentoCard>
    </BentoGrid>
  );
}
