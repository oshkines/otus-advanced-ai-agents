import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { TrimaxionMark } from "@/components/brand/TrimaxionMark";
import { ModuleCard } from "@/components/overview/ModuleCard";
import { OverviewCta } from "@/components/overview/OverviewCta";
import type { IconName } from "@/lib/orchestrator/types";

export const metadata: Metadata = {
  title: "Обзор продукта",
  description:
    "AI Dev Navigator: единый дашборд для Email-каскада, мониторинга РЖД, парсера вакансий и C++20-ядра NotificationRouter.",
};

interface ModuleSpec {
  readonly icon: IconName;
  readonly index: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly bullets: readonly string[];
}

/** Четыре модуля продукта — ровно те, что описаны в config/orchestrator.json. */
const MODULES: readonly ModuleSpec[] = [
  {
    icon: "mail",
    index: "01",
    title: "Email-каскад",
    tagline: "whitelist → v3 → r1",
    description:
      "Письмо проходит по возрастающей цене токена: сначала правила отправителей, затем лёгкая модель, и только спорные случаи уходят на модель с рассуждением.",
    bullets: [
      "Вердикты: ответить, проверить, архив, спам",
      "Тело письма докачивается по требованию",
      "Дедупликация в таблице processed_emails",
    ],
  },
  {
    icon: "train",
    index: "02",
    title: "Мониторинг РЖД",
    tagline: "места · цены · вагоны",
    description:
      "Воркер сверяет рейсы на даты каникул и показывает свободные места, вилку цен и тип вагона — без ручного перещёлкивания сайтов.",
    bullets: [
      "Купе, плацкарт и СВ в одном срезе",
      "Окно дат каникул Алфёровского вуза",
      "Оптимистичная бронь прямо из карточки",
    ],
  },
  {
    icon: "briefcase",
    index: "03",
    title: "Парсер вакансий",
    tagline: "c++ · 1c · remote",
    description:
      "Сканер собирает вакансии по тегам и отдаёт их единой лентой: источник, дата публикации и вилка — в одной строке, без перехода на сайт.",
    bullets: [
      "Расписание из конфига: 0 */6 * * *",
      "Теги C++, 1C, Remote",
      "Повторы отсекает SQLite-кэш",
    ],
  },
  {
    icon: "bell",
    index: "04",
    title: "NotificationRouter",
    tagline: "c++20 core",
    description:
      "Ядро: планировщик, менеджер процессов и маршрутизатор событий. Воркеры общаются с ним только через JSON в stdout — падение канала не роняет систему.",
    bullets: [
      "timeout_sec на каждый воркер",
      "Изоляция сбоев: канал падает, ядро живёт",
      "Один конфиг — источник истины",
    ],
  },
];

interface PipelineStep {
  readonly step: string;
  readonly title: string;
  readonly description: string;
}

/** Три шага конвейера: собрать → классифицировать → показать. */
const PIPELINE: readonly PipelineStep[] = [
  {
    step: "01",
    title: "Собираем",
    description:
      "Python-воркеры на чистых корутинах опрашивают IMAP, вакансии и РЖД по расписанию из конфига.",
  },
  {
    step: "02",
    title: "Классифицируем",
    description:
      "ИИ-каскад экономит токены: правила, затем DeepSeek-V3, и только сложное — DeepSeek-R1.",
  },
  {
    step: "03",
    title: "Показываем",
    description:
      "Bento-дашборд отдаёт только решения: что ответить, что проверить и какие билеты ещё доступны.",
  },
];

/** Метрики шапки: короткие факты вместо маркетинговых обещаний. */
const HERO_STATS: readonly { readonly label: string; readonly value: string }[] = [
  { label: "Модуля", value: "4" },
  { label: "Контракт", value: "JSON" },
  { label: "Кэш", value: "SQLite" },
  { label: "A11Y", value: "≥ 7:1" },
];

/**
 * Публичная MVP-страница `/overview`.
 *
 * Живёт вне route group `(dashboard)`, поэтому рендерится без сайдбара и без
 * чтения конфига: это статическая витрина продукта, а не рабочая панель.
 * Структура блоков вдохновлена Tailark Dusk: тёмная canvas-подложка,
 * последовательность «оффер → доказательства → модули → путь события → CTA».
 * Палитра и радиусы — только из токенов `@theme` (design.md §2, §4).
 */
export default function OverviewPage(): ReactElement {
  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <header className="border-b border-border/70">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/overview"
            aria-current="page"
            className="flex min-w-0 items-center gap-2.5 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-canvas text-primary"
            >
              <TrimaxionMark size={18} />
            </span>
            <span className="min-w-0">
              <span className="block font-mono text-[11px] leading-4 uppercase tracking-[0.22em] text-muted">
                AI DEV
              </span>
              <span className="block truncate font-mono text-sm font-semibold leading-5 text-ink">
                Navigator
              </span>
            </span>
          </Link>

          <nav aria-label="Навигация витрины" className="flex shrink-0 items-center gap-2">
            <a
              href="#modules"
              className="hidden rounded-control px-2 py-1 text-xs text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:inline-flex"
            >
              Модули
            </a>
            <OverviewCta
              href="/"
              testId="overview-cta-header"
              className="h-9 px-3 text-xs"
            >
              Открыть дашборд
            </OverviewCta>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-8 sm:px-6 sm:pt-16">
          <p className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface/70 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success-soft" />
            MVP · Phase 5
          </p>

          <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl lg:text-5xl">
            Один экран вместо десяти вкладок:{" "}
            <span className="text-primary">почта, вакансии и билеты</span> под контролем
          </h1>

          <p className="mt-4 max-w-2xl text-base leading-7 text-muted">
            AI Dev Navigator — сдержанный инженерный дашборд поверх C++20-ядра
            NotificationRouter и асинхронных Python-воркеров. Модули собирают события,
            ИИ-каскад экономит токены, а вы видите только то, что требует решения.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <OverviewCta href="/" testId="overview-cta-hero">
              Открыть рабочий дашборд
              <span aria-hidden="true">→</span>
            </OverviewCta>
            <OverviewCta href="#modules" tone="ghost">
              Смотреть модули
            </OverviewCta>
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {HERO_STATS.map((stat) => (
              <div
                key={stat.label}
                className="rounded-bento border border-border bg-surface/60 px-4 py-3"
              >
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                  {stat.label}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold leading-6 text-ink">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="modules" className="mx-auto w-full max-w-6xl scroll-mt-4 px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/70 pb-3">
            <h2 className="text-xl font-semibold leading-7 text-ink">Четыре модуля — один контур</h2>
            <p className="text-xs text-muted">
              состав, иконки и расписания берутся из config/orchestrator.json
            </p>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {MODULES.map((module) => (
              <ModuleCard
                key={module.title}
                icon={module.icon}
                index={module.index}
                title={module.title}
                tagline={module.tagline}
                description={module.description}
                bullets={module.bullets}
              />
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/70 pb-3">
            <h2 className="text-xl font-semibold leading-7 text-ink">Путь события</h2>
            <p className="text-xs text-muted">от письма до решения на экране</p>
          </div>

          <ol className="mt-4 grid gap-4 md:grid-cols-3">
            {PIPELINE.map((item) => (
              <li key={item.step} className="rounded-bento border border-border bg-surface p-5">
                <p className="font-mono text-[11px] tracking-[0.2em] text-idle">{item.step}</p>
                <h3 className="mt-2 text-base font-semibold leading-6 text-ink">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{item.description}</p>
              </li>
            ))}
          </ol>

          <div className="mt-4 rounded-bento border border-border bg-surface p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
              Каскад экономии токенов
            </p>
            <p className="mt-2 break-words font-mono text-xs leading-6 text-ink">
              WhiteList → DeepSeek-V3 (deepseek-chat) → DeepSeek-R1 (deepseek-reasoner)
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Дешёвые правила закрывают основную массу писем; дорогая модель с рассуждением
              вызывается только там, где классификация действительно неоднозначна.
            </p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-bento border border-border bg-surface p-5 md:col-span-2">
              <h2 className="text-xl font-semibold leading-7 text-ink">Что уже работает</h2>
              <ul className="mt-3 space-y-2">
                <li className="flex gap-2 text-sm leading-6 text-muted">
                  <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-success-soft" />
                  <span>
                    Bento-дашборд на Next.js 15 и Tailwind v4: обзор, Email, Вакансии, РЖД —
                    маршруты собираются из конфига ядра.
                  </span>
                </li>
                <li className="flex gap-2 text-sm leading-6 text-muted">
                  <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-success-soft" />
                  <span>
                    Каркас почтового воркера на чистых корутинах и режим симуляции без сети.
                  </span>
                </li>
                <li className="flex gap-2 text-sm leading-6 text-muted">
                  <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-success-soft" />
                  <span>
                    Грациозная деградация: битый конфиг, офлайн и отсутствие воркера не роняют
                    страницу.
                  </span>
                </li>
              </ul>
            </div>

            <div className="rounded-bento border border-warning/40 bg-warning/5 p-5">
              <p className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-warning">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
                not_connected
              </p>
              <p className="mt-3 text-sm leading-6 text-muted">
                Воркеры РЖД и вакансий ещё не подключены: карточки каналов показывают
                данные-заглушки, переход по ним заблокирован. Честный статус важнее
                красивой цифры.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-6 sm:px-6">
          <div className="rounded-bento border border-border bg-surface p-6 sm:p-8">
            <h2 className="text-2xl font-bold leading-8 tracking-tight text-ink">
              Дашборд уже собирается из конфига
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              Откройте рабочий обзор: модули, состояние воркеров, SQLite-кэш и e2e-контур на
              одном экране.
            </p>
            <div className="mt-5">
              <OverviewCta href="/" testId="overview-cta-final">
                Открыть рабочий дашборд
                <span aria-hidden="true">→</span>
              </OverviewCta>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted sm:px-6">
          <p>AI Dev Navigator · GSD-Core · Phase 5</p>
          <p className="font-mono">/overview · рабочий дашборд: /</p>
        </div>
      </footer>
    </div>
  );
}

