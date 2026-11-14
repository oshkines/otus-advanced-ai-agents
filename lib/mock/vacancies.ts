/**
 * MOCK: вакансии для страницы `/vacancies`.
 * Теги соответствуют `workers[vacancy_scanner].args` в config/orchestrator.json.
 * Заменяется данными `agents/vacancy_scanner.py` после включения воркера.
 */
export interface MockVacancy {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly stack: string;
  readonly salary: string;
  readonly source: string;
  readonly publishedAt: string;
}

export const MOCK_VACANCIES: readonly MockVacancy[] = [
  {
    id: "vac-001",
    company: "AlferSoft",
    title: "C++ Developer (Middle)",
    stack: "C++20, CMake, MSVC",
    salary: "180 000 — 240 000 ₽",
    source: "hh.ru",
    publishedAt: "2026-10-31",
  },
  {
    id: "vac-002",
    company: "RetailTech",
    title: "1С-программист",
    stack: "1C 8.3, SQL, HTTP-сервисы",
    salary: "150 000 — 200 000 ₽",
    source: "career.1c.ru",
    publishedAt: "2026-10-30",
  },
  {
    id: "vac-003",
    company: "DataForge",
    title: "Python-инженер автоматизации",
    stack: "Python 3.12, asyncio, pytest",
    salary: "170 000 — 220 000 ₽",
    source: "remote.ok",
    publishedAt: "2026-10-30",
  },
  {
    id: "vac-004",
    company: "Orchestra Labs",
    title: "Fullstack (Next.js + C++)",
    stack: "Next.js 15, Tailwind v4, C++20",
    salary: "200 000 — 260 000 ₽",
    source: "hh.ru",
    publishedAt: "2026-10-29",
  },
];
