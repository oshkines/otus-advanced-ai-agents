import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { cn } from "@/lib/cn";
import { MOCK_EMAILS, VERDICT_LABEL, type EmailVerdict } from "@/lib/mock/emails";
import { findSection } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Readonly<Record<EmailVerdict, string>> = {
  apply: "border-ok/50 bg-ok/10 text-ok",
  review: "border-warn/50 bg-warn/10 text-warn",
  ignore: "border-line bg-canvas/60 text-muted",
  spam: "border-danger/50 bg-danger/10 text-danger",
};

/** Канал Email: счётчики + список писем с ИИ-вердиктами (п.4.2 DISCUSS.md). */
export default async function EmailPage(): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();
  const section = findSection(snapshot.nav, "email");

  const total = MOCK_EMAILS.length;
  const actionable = MOCK_EMAILS.filter(
    (email) => email.verdict === "apply" || email.verdict === "review",
  ).length;
  const rejected = MOCK_EMAILS.filter(
    (email) => email.verdict === "ignore" || email.verdict === "spam",
  ).length;

  return (
    <>
      <SectionHeader
        section={section}
        title="Email"
        description="Входящие письма с ИИ-вердиктами: что ответить, что проверить, что в архив"
      />

      <BentoGrid>
        <BentoCard
          title="Всего писем"
          className="col-span-6 md:col-span-4 lg:col-span-3"
          testId="email-total-card"
        >
          <p className="text-3xl font-semibold">{total}</p>
          <p className="mt-1 text-xs text-muted">за последние сутки</p>
        </BentoCard>

        <BentoCard
          title="Требуют ответа"
          className="col-span-6 md:col-span-4 lg:col-span-3"
          testId="email-actionable-card"
        >
          <p className="text-3xl font-semibold text-ok">{actionable}</p>
          <p className="mt-1 text-xs text-muted">вердикты «ответить» и «проверить»</p>
        </BentoCard>

        <BentoCard
          title="Отклонено"
          className="col-span-12 md:col-span-4 lg:col-span-6"
          testId="email-rejected-card"
        >
          <p className="text-3xl font-semibold text-muted">{rejected}</p>
          <p className="mt-1 text-xs text-muted">архив и спам</p>
          <div className="mt-3">
            <Metric
              label="Таблица кэша"
              value={section?.storageTable ?? "processed_emails"}
              mono
            />
            <Metric
              label="Воркер"
              value={section?.workerIds.join(", ") || "email_watcher"}
              mono
            />
          </div>
        </BentoCard>

        <BentoCard
          title="Письма"
          subtitle="отправитель · тема · вердикт"
          className="col-span-12"
          testId="email-list-card"
        >
          <ul className="divide-y divide-line/70">
            {MOCK_EMAILS.map((email) => (
              <li key={email.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{email.subject}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {email.from} · {email.receivedAt}
                  </p>
                  <p className="mt-1 text-xs text-muted">{email.reason}</p>
                </div>
                <span
                  className={cn(
                    "w-fit shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold",
                    VERDICT_TONE[email.verdict],
                  )}
                >
                  {VERDICT_LABEL[email.verdict]}
                </span>
              </li>
            ))}
          </ul>
        </BentoCard>
      </BentoGrid>
    </>
  );
}
