import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { BentoGrid } from "@/components/bento/BentoGrid";
import { Metric } from "@/components/bento/Metric";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { ApiStatusBadge } from "@/components/states/ApiStatusBadge";
import { NewVacancyForm } from "@/components/vacancies/NewVacancyForm";
import { VacancyIgnoreToggle } from "@/components/vacancies/VacancyIgnoreToggle";
import { describeApiFailure, fetchVacancies, getApiBaseUrl } from "@/lib/api/client";
import type { Vacancy } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
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

/** Вилка вакансии в одну строку (числа — `Decimal` из PostgreSQL). */
function salaryText(vacancy: Vacancy): string {
  const { salary_min: min, salary_max: max, currency } = vacancy;
  if (min === null && max === null) {
    return "вилка не указана";
  }
  if (min !== null && max !== null) {
    return `${formatNumber(min)} — ${formatNumber(max)} ${currency}`;
  }
  if (min !== null) {
    return `от ${formatNumber(min)} ${currency}`;
  }
  return `до ${formatNumber(max ?? 0)} ${currency}`;
}

/**
 * Канал «Вакансии»: список из `GET /api/v1/vacancies` + CRUD-действия.
 *
 * - `POST /api/v1/vacancies` — ручное добавление (идемпотентный UPSERT);
 * - `PATCH /api/v1/vacancies/{id}` — переключение игнора (`is_ignored`).
 *
 * При недоступном API страница показывает MOCK-строки без кнопок и статус
 * `API offline / fallback` — белого экрана не будет.
 */
export default async function VacanciesPage(): Promise<ReactElement> {
  const [snapshot, listResult] = await Promise.all([
    loadDashboardSnapshot(),
    fetchVacancies({ limit: 50 }),
  ]);

  const section = findSection(snapshot.nav, "vacancies");
  const tags = extractTags(section?.workers[0]?.args ?? []);

  const vacancies = listResult.ok ? listResult.data.items : [];
  const total = listResult.ok ? listResult.data.total : MOCK_VACANCIES.length;
  const active = vacancies.filter((vacancy) => !vacancy.is_ignored).length;
  const ignored = vacancies.filter((vacancy) => vacancy.is_ignored).length;

  const apiDetail = listResult.ok
    ? `${getApiBaseUrl()} · ${listResult.latencyMs} мс · ${listResult.data.items.length}/${listResult.data.total}`
    : listResult.error.kind === "offline"
      ? getApiBaseUrl()
      : describeApiFailure(listResult.error);

  return (
    <>
      <SectionHeader
        section={section}
        generatedAtIso={snapshot.generatedAtIso}
        title="Вакансии"
        description="Сканер вакансий и ручные записи в PostgreSQL: игнор по формату работы через PATCH"
        banner={<ApiStatusBadge online={listResult.ok} detail={apiDetail} />}
      />

      <BentoGrid>
        <BentoCard
          title="Найдено"
          className="col-span-12 md:col-span-4 lg:col-span-4"
          testId="vacancies-total-card"
        >
          <p className="text-3xl font-semibold">{formatNumber(total)}</p>
          <p className="mt-1 text-xs text-muted">
            {listResult.ok ? "GET /api/v1/vacancies" : "MOCK fallback"}
          </p>
        </BentoCard>

        <BentoCard
          title="Активные"
          className="col-span-6 md:col-span-4 lg:col-span-4"
          testId="vacancies-active-card"
        >
          <p className="text-3xl font-semibold text-ok">{formatNumber(active)}</p>
          <p className="mt-1 text-xs text-muted">is_ignored = false</p>
        </BentoCard>

        <BentoCard
          title="В игноре"
          className="col-span-6 md:col-span-4 lg:col-span-4"
          testId="vacancies-ignored-card"
        >
          <p className="text-3xl font-semibold text-muted">{formatNumber(ignored)}</p>
          <p className="mt-1 text-xs text-muted">переключается через PATCH</p>
        </BentoCard>

        <BentoCard
          title="Теги фильтра"
          subtitle={section?.workers[0]?.id ?? "vacancy_scanner"}
          className="col-span-12 md:col-span-6 lg:col-span-7"
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
          className="col-span-12 md:col-span-6 lg:col-span-5"
          testId="vacancies-schedule-card"
        >
          <Metric label="Cron" value={section?.workers[0]?.schedule ?? "—"} mono />
          <Metric label="Таймаут" value={`${section?.workers[0]?.timeout_sec ?? 0} s`} mono />
          <Metric label="Состояние" value={section?.status ?? "not_connected"} mono />
        </BentoCard>

        <BentoCard
          title="Новая вакансия"
          subtitle="POST /api/v1/vacancies"
          className="col-span-12 lg:col-span-5"
          testId="vacancies-create-card"
        >
          <NewVacancyForm />
        </BentoCard>

        <BentoCard
          title="Вакансии"
          subtitle={
            listResult.ok
              ? `${listResult.data.items.length} из ${listResult.data.total} · PostgreSQL`
              : "MOCK fallback"
          }
          className="col-span-12 lg:col-span-7"
          testId="vacancies-list-card"
        >
          {listResult.ok ? (
            vacancies.length === 0 ? (
              <p className="text-sm text-muted">
                В таблице vacancies пока нет записей: добавьте первую формой слева.
              </p>
            ) : (
              <ul className="divide-y divide-line/70">
                {vacancies.map((vacancy) => (
                  <li
                    key={vacancy.id}
                    className="flex flex-col gap-2 py-3 lg:flex-row lg:items-start lg:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <p className="text-sm font-medium text-ink">{vacancy.title}</p>
                        <span className="text-xs text-muted">
                          {vacancy.company.length > 0 ? vacancy.company : "—"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {vacancy.stack.length > 0 ? vacancy.stack.join(", ") : "стек не указан"} ·{" "}
                        {vacancy.source} · {vacancy.work_format ?? "формат ?"} · {vacancy.status}
                        {vacancy.score === null ? "" : ` · score ${vacancy.score}`}
                      </p>
                      <p className="mt-1 font-mono text-xs text-ok">{salaryText(vacancy)}</p>
                      {vacancy.url === null ? null : (
                        <a
                          href={vacancy.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block max-w-full truncate font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                        >
                          {vacancy.url}
                        </a>
                      )}
                    </div>
                    <VacancyIgnoreToggle
                      vacancyId={vacancy.id}
                      isIgnored={vacancy.is_ignored}
                    />
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <p className="mb-2 text-[11px] text-muted">
                FastAPI недоступен: показаны MOCK-вакансии без управления игнором.
              </p>
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
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </>
  );
}
