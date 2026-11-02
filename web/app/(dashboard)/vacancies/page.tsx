import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { MOCK_VACANCIES } from "@/lib/mock/vacancies";
import { findSection } from "@/lib/orchestrator/derive";
import { loadDashboardSnapshot } from "@/lib/orchestrator/snapshot";

export const dynamic = "force-dynamic";

/** Теги сканера берём из `workers[vacancy_scanner].args` (--tags "C++, 1C, Remote"). */
function extractTags(args: readonly string[]): readonly string[] {
  const index = args.indexOf("--tags");
  if (index === -1) {
    return [];
  }
  const raw: string | undefined = args[index + 1];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Канал «Вакансии»: теги фильтра из конфига + список найденных вакансий (MOCK). */
export default async function VacanciesPage(): Promise<ReactElement> {
  const snapshot = await loadDashboardSnapshot();
  const section = findSection(snapshot.nav, "vacancies");
  const tags = extractTags(section?.workers[0]?.args ?? []);

  return (
    <>
      <SectionHeader
        section={section}
        generatedAtIso={snapshot.generatedAtIso}
        title="Вакансии"
        description="Сканер вакансий по тегам из config/orchestrator.json (workers[vacancy_scanner].args)"
      />

      <BentoGrid>
        <BentoCard
          title="Найдено"
          className="col-span-6 md:col-span-4 lg:col-span-3"
          testId="vacancies-total-card"
        >
          <p className="text-3xl font-semibold">{MOCK_VACANCIES.length}</p>
          <p className="mt-1 text-xs text-muted">после фильтра по тегам</p>
        </BentoCard>

        <BentoCard
          title="Теги фильтра"
          subtitle={section?.workers[0]?.id ?? "vacancy_scanner"}
          className="col-span-6 md:col-span-8 lg:col-span-5"
          testId="vacancies-tags-card"
        >
          {tags.length === 0 ? (
            <p className="text-sm text-muted">В args воркера теги не заданы.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-line bg-canvas/60 px-3 py-1 font-mono text-[11px] text-ink"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        <BentoCard
          title="Расписание"
          className="col-span-12 md:col-span-6 lg:col-span-4"
          testId="vacancies-schedule-card"
        >
          <Metric label="Cron" value={section?.workers[0]?.schedule ?? "—"} mono />
          <Metric label="Таймаут" value={`${section?.workers[0]?.timeout_sec ?? 0} s`} mono />
          <Metric label="Состояние" value={section?.status ?? "not_connected"} mono />
        </BentoCard>

        <BentoCard
          title="Вакансии"
          subtitle="компания · стек · вилка"
          className="col-span-12 lg:col-span-8"
          testId="vacancies-list-card"
        >
          <ul className="divide-y divide-line/70">
            {MOCK_VACANCIES.map((vacancy) => (
              <li key={vacancy.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-ink">
                    {vacancy.title} · {vacancy.company}
                  </p>
                  <p className="font-mono text-xs text-ok">{vacancy.salary}</p>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {vacancy.stack} · {vacancy.source} · {vacancy.publishedAt}
                </p>
              </li>
            ))}
          </ul>
        </BentoCard>
      </BentoGrid>
    </>
  );
}
