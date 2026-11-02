# Phase 5 Plan: Bento Dashboard UI + управляемая деградация

> **Фаза:** `phase-05-bento-dashboard` · **Статус:** READY FOR REVIEW — замечания ревью 7/10 закрыты,
> открыт один пункт (AC-4, см. §6) · **Дата обновления:** 02.11.2026
> **Дата плана:** 02.11.2026 · **Владелец:** Евгений
> **Артефакты фазы:** `DISCUSS.md` (решения), `DESIGN.md` (спека), `CONTRACT.md` (контракт),
> `PLAN.md` (этот файл).
> **Входы:** `design.md`, `config/orchestrator.json` v0.2.0, `docs/research/BENCHMARKING.md`,
> `docs/handoff/PRD_CHALLENGE.md`, `.planning/PROGRESS.md`.

## 1. Цель фазы и Definition of Ready

**Цель.** Дашборд с единым источником правды по дизайну (`design.md` → `web/app/globals.css` →
`src/status_panel.html`), тремя каналами (Email / Вакансии / РЖД), оптимистичными переходами
и предсказуемой обработкой ошибок: конфиг, сеть, рендер, форма, 404.

**Definition of Ready (выполнено):**
- [x] Согласованы ответы на 6 открытых вопросов (`DISCUSS.md` §4).
- [x] Зафиксирован контракт `UI ↔ orchestrator.json` (`CONTRACT.md`).
- [x] Собран ресерч аналогов и обоснование палитры (`docs/research/BENCHMARKING.md`).
- [x] Описаны User Stories и AC для трёх каналов (`docs/handoff/PRD_CHALLENGE.md`).

## 2. Чек-лист задач фазы

### A. Источники правды и дизайн-система

- [x] **A-1.** Корневой `design.md` объявляет финальный стек: canvas `#0A0E17`,
      surface `#161B22`, код и логи — `JetBrains Mono`.
- [x] **A-2.** В `design.md` §10 добавлен запрет slate-палитры и `Consolas`.
- [x] **A-3.** `web/app/globals.css` — единственный источник CSS-токенов; `Consolas` удалён
      из `--font-mono`, остаётся `JetBrains Mono → SF Mono → Cascadia Mono → ui-monospace`.
- [x] **A-4.** `src/status_panel.html` приведён к тем же токенам (фон, карточки, границы,
      ink/muted, success/warning, JetBrains Mono).
- [x] **A-5.** `.planning/phases/.../DESIGN.md` §2 переписан под финальные токены;
      упоминание «slate-400 на slate-800» заменено на измеренные контрасты.
- [x] **A-6.** `DISCUSS.md` больше не называет текущий UI «slate».
- [x] **A-7.** Grep по `0f172a|1e293b|334155|94a3b8|e2e8f0|64748b|Consolas` — 0 совпадений
      в `web/`, `src/`, `.planning/`, `design.md`.

### B. Документация (ресерч, handoff, план)

- [x] **B-1.** `docs/research/BENCHMARKING.md`: разбор Linear, gethomepage.dev, Vercel Dashboard.
- [x] **B-2.** Таблицы «БЕРЁМ / НЕ БЕРЁМ» по фичам (F-01…F-15), UI (13 строк) и UX (11 строк).
- [x] **B-3.** Обоснование `#0A0E17`: оттенок, яркость, контрасты WCAG, отказ от чистого `#000`.
- [x] **B-4.** `docs/handoff/PRD_CHALLENGE.md`: персоны, глоссарий, 14 User Stories с AC.
- [x] **B-5.** Сценарии ошибок E2E: focus loss, три уровня сети/ConfigError, деградация без
      белого экрана, partial/timeout, битый конфиг, 404.
- [x] **B-6.** Матрица состояний, copy deck, трассируемость US → код → `data-testid`.
- [x] **B-7.** `.planning/phases/phase-05-bento-dashboard/PLAN.md` (этот файл).

### C. UI-состояния и переходы в `web/`

- [x] **C-1.** `components/states/ConfigError.tsx` — прозрачная ошибка конфига + путь + причина.
- [x] **C-2.** `components/states/ReloadButton.tsx` — «Повторить» через `router.refresh()`.
- [x] **C-3.** `components/states/OfflineBanner.tsx` — `online/offline` без гидрационных скачков.
- [x] **C-4.** `components/states/RouteError.tsx` + `app/error.tsx` — граница ошибок маршрута.
- [x] **C-5.** `app/global-error.tsx` — падение корневого layout не даёт белого экрана
      (inline-стили палитры проекта).
- [x] **C-6.** `app/not-found.tsx` — 404 с навигацией; `app/loading.tsx` — skeleton без layout shift.
- [x] **C-7.** `components/interactive/OptimisticAction.tsx` — idle → pending (шаги) → success/error.
- [x] **C-8.** `components/interactive/BlurValidatedForm.tsx` — blur-валидация, сохранение значений,
      `aria-invalid` / `aria-describedby`, Escape, возврат фокуса при сабмите.
- [x] **C-9.** Email: кнопка «Полное письмо» на каждом письме (Optimistic UI).
- [x] **C-10.** РЖД: «Купить билет» + форма пассажира + окно каникул + «До выезда».
- [x] **C-11.** AppShell использует `ConfigError`; сайдбар не зависит от конфига.
- [x] **C-12.** Все новые блоки имеют `data-testid` и доступные имена.

### D. Проверки и артефакты

- [x] **D-1.** `npm run typecheck` (`tsc --noEmit`) в `web/` — без ошибок.
- [x] **D-2.** `npm run build` — без ошибок (dev-сервер остановлен, см. `docs/troubleshooting.md` 001).
      Проверено 02.11.2026: exit 0, собраны `/`, `/_not-found`, `/email`, `/rzhd`, `/vacancies`.
- [ ] **D-3.** `tests/browser_test_dashboard.py` — Playwright Python: якоря + скриншот.
      Не создан: в `tests/` пока только `browser_test.py` (статус-панель C++ ядра).
- [x] **D-4.** Скриншот `web/public/screenshots/dashboard_desktop.png` (1440×900, reduced-motion).
      Проверено 02.11.2026: production `npm run build` + `npm run start:e2e` (:3100), viewport
      1440×900, `deviceScaleFactor=2`, `prefers-reduced-motion`, PNG 2880×1800, 771 775 Б.
- [ ] **D-5.** Ручная проверка состояний: `ConfigError`, `OfflineBanner`, `not-found`, форма.
      Частично: `/nope` → 404 с навигацией проверен автоматически (Playwright);
      `ConfigError` (переименование конфига), `OfflineBanner` (DevTools Offline) и форма —
      не прогонялись вручную, вынесены в Phase 6.
- [x] **D-6.** `pre-commit.bat` → exit 0 (конфиг ASCII-only, валидный JSON).
      Проверено 02.11.2026: 3/3 проверки, exit 0.

## 3. Матрица приоритетов (MoSCoW)

Легенда: **Must** — без этого фаза не принимается; **Should** — важно, но можно вынести
в Phase 6 при форс-мажоре; **Could** — улучшение; **Won't** — осознанно вне фазы.

### Must (обязательно)

| ID | Требование | Критерий приёмки |
|---|---|---|
| M-01 | Единый источник токенов | `design.md`, `web/app/globals.css`, `src/status_panel.html` дают одинаковые значения canvas/surface/font |
| M-02 | Удаление slate/Consolas | Grep по `0f172a|1e293b|334155|94a3b8|Consolas` = 0 в `web/`, `src/`, `.planning/`, `design.md` |
| M-03 | Нет белого экрана | `error.tsx`, `global-error.tsx`, `not-found.tsx` отрисованы в палитре проекта |
| M-04 | `ConfigError` с повтором | Баннер `config-error-banner` + кнопка «Повторить» + путь к конфигу |
| M-05 | `OfflineBanner` | Реакция на `online/offline`, `role="status"`, `aria-live="polite"` |
| M-06 | Focus-loss форма | Blur-валидация, значения сохраняются, `aria-invalid`/`aria-describedby` |
| M-07 | Optimistic UI | Email («Полное письмо») и РЖД («Купить билет»): шаги, `disabled`, success/error |
| M-08 | Документы ресерча и handoff | `docs/research/BENCHMARKING.md`, `docs/handoff/PRD_CHALLENGE.md` |
| M-09 | Зелёные проверки | `npm run typecheck` и `npm run build` без ошибок |
| M-10 | Актуальный скриншот | `web/public/screenshots/dashboard_desktop.png` переснят с текущего UI |

### Should (важно)

| ID | Требование | Критерий приёмки |
|---|---|---|
| S-01 | Partial/timeout-состояние | Метка времени + `warning`, данные не очищаются (контракт в PRD §7.4) |
| S-02 | «До выезда» на `/rzhd` | Дни до 26.12.2026, «Сегодня» при 0, «Каникулы начались» после |
| S-03 | A11y-проход | Tab-обход всех действий, видимый фокус, статусы текстом |
| S-04 | E2E дашборда | `tests/browser_test_dashboard.py` проверяет якоря и снимает скриншот |

### Could (можно отложить)

| ID | Требование | Почему не в Must |
|---|---|---|
| C-01 | Command palette | Каналов 4; окупаемость появится после 6 |
| C-02 | Сортировка вакансий | Данные MOCK, сортировать нечего |
| C-03 | Self-host `JetBrains Mono` (woff2) | Пока работает системный fallback; нужен вес и лицензия |
| C-04 | История метрик / sparkline | Нет источника временных рядов до Phase 6 |

### Won't (вне фазы)

| ID | Что | Причина |
|---|---|---|
| W-01 | Светлая тема | Один сценарий, тёмная инженерная тема — требование `design.md` §1 |
| W-02 | Авторизация и роли | Один пользователь, локальный запуск |
| W-03 | BFF + polling | Ветка B, заложена контрактом; включается в Phase 6 |
| W-04 | Деплой-действия / rollback | Нет домена деплоя |
| W-05 | YAML-конфиг вместо JSON | Ломает контракт с C++ ядром |

## 4. Анализ технических рисков и митигация

Шкала: вероятность/влияние — низкая / средняя / высокая. «Триггер» — событие, по которому
риск реализуется.

| ID | Риск | Вер. | Влияние | Триггер | Митигация | Проверка |
|---|---|---|---|---|---|---|
| R-01 | Расхождение источников правды (палитра/шрифт) | средняя | высокое | Правка в одном файле без остальных | `design.md` — источник смысла, `globals.css` — источник токенов, `status_panel.html` синхронизирован; запрет в `design.md` §10 | Grep в DoD (D-6/PLAN), визуальный аудит |
| R-02 | `next dev` и `next build` делят `web/.next` → 500 | высокая | среднее | Сборка при запущенном dev | Останавливать dev перед build; `docs/troubleshooting.md` № 001 | Проверка `curl` 200 после рестарта |
| R-03 | Путь с пробелами и кириллицей ломает Node/Python | высокая | высокое | `fs.readFile` со строковой склейкой, `file://` в тестах | `path.resolve` + `ORCHESTRATOR_CONFIG_PATH`; в Python — `Path.as_uri()` | typecheck + e2e |
| R-04 | `next build` не тащит `../config` в трейс | средняя | высокое | `outputFileTracingIncludes` отсутствует | Оставить `outputFileTracingIncludes: { "/**": ["../config/orchestrator.json"] }` | `npm run build` + `npm run start:e2e` |
| R-05 | Гидрационные расхождения client-компонентов | средняя | среднее | `navigator.onLine`, `Date.now()` на сервере и клиенте | Начальное состояние детерминировано; чтение `navigator` только в `useEffect`; расчёт даты — на сервере | Консоль браузера без `Hydration failed` |
| R-06 | Белый экран при непойманном исключении | низкая | высокое | Ошибка в Server/Client Component | `app/error.tsx` + `app/global-error.tsx` с inline-стилями | Инъекция `throw new Error` |
| R-07 | Регресс доступности | средняя | среднее | Новые кнопки без `aria-*` и фокуса | `aria-busy`, `aria-live`, `focus-visible`, текстовые статусы | Tab-обход + скринридер |
| R-08 | MOCK-данные принимают за боевые | высокая | среднее | Демонстрация без бейджа | Бейдж «MOCK-данные», статус `not_connected`, PRD §1 | Визуальная проверка |
| R-09 | Отсутствующий воркер роняет страницу | средняя | высокое | Пустой `workers[]`, нет `navigation` | `DEFAULT_NAVIGATION`, `not_connected`, guard `config === null` | Открыть `/`, `/email` без конфига |
| R-10 | Скриншот «дрейфует» от реального UI | высокая | низкое | Ручная съёмка в разное время/размере | Скрипт Playwright: 1440×900, `deviceScaleFactor=2`, `reduced_motion="reduce"` | Повторный прогон D-3 |
| R-11 | `JetBrains Mono` не установлен локально → fallback | средняя | низкое | Чистая машина без шрифта | Стек `JetBrains Mono → SF Mono → Cascadia Mono → ui-monospace`; в README зафиксировать | Сравнение ширины глифов в скриншоте |
| R-12 | Дрейф дат каникул / часовой пояс | низкая | среднее | Клиент в другом TZ, наступил 2027 год | Расчёт на сервере по Europe/Moscow; окно в `lib/mock/rzhd.ts` как единственный источник | Проверка «Сегодня» / «Каникулы начались» |

## 5. Порядок выполнения и зависимости

```
A (источники правды)
   └─► B (ресерч + PRD + план)          — можно параллельно с A
          └─► C-1…C-6 (состояния ошибок)   — зависит от AppShell и layout
          └─► C-7…C-10 (интерактив)        — зависит от B-4/B-5 (copy deck)
                  └─► D-1 typecheck
                        └─► D-2 build (dev остановлен)
                              └─► D-3/D-4 e2e + скриншот
                                    └─► D-5 ручные проверки
                                          └─► D-6 pre-commit
```

**Правила выполнения:**
1. Сначала фиксируем токены (A), только потом правим компоненты — иначе снова разъедемся.
2. Документы (B) не зависят от кода, но copy deck из `PRD_CHALLENGE.md` §7.8 — источник строк
   для компонентов C-7…C-10.
3. `npm run build` запускается **только** при остановленном `next dev` (риск R-02).
4. Скриншот снимается скриптом, не вручную (риск R-10).

## 6. Exit criteria (Definition of Done фазы)

- [x] Все **Must** (M-01…M-10) закрыты и подтверждены ссылкой на файл/якорь.
- [x] `npm run typecheck` и `npm run build` — exit 0 (02.11.2026).
- [x] `/`, `/email`, `/vacancies`, `/rzhd` открываются без ошибок в консоли
      (Playwright: HTTP 200 + `console_errors=0`, `page_errors=0`).
- [ ] `ConfigError` проверен переименованием конфига; `OfflineBanner` — DevTools Offline.
      Открыто: **AC-4** — при `config === null` `app/(dashboard)/page.tsx` делает ранний `return`,
      поэтому карточки каналов не рендерятся (баннер `config-error-banner` и сайдбар-заглушки есть).
      Правка на Phase 6: отрисовать карточки из `DEFAULT_NAVIGATION` со статусом `not_connected`.
- [x] `/nope` отдаёт 404 с навигацией, а не белый экран (проверено Playwright: `h1='404'`).
- [ ] Форма пассажира: blur не теряет данные, ошибка появляется inline, офлайн сохраняет значения.
      Открыто: ручной прогон не выполнялся (код `BlurValidatedForm` + `OptimisticAction` готов).
- [x] Скриншот `web/public/screenshots/dashboard_desktop.png` обновлён (D-4).
- [x] Grep по slate/Consolas = 0; `pre-commit.bat` → exit 0.
      Уточнение: в коде (`web/`, `src/`, `design.md`) совпадений нет; в документации эти значения
      встречаются только в тексте запрета (`DESIGN.md` §2, `BENCHMARKING.md` «НЕ БЕРЁМ», план A-2).
- [x] `docs/research/BENCHMARKING.md` и `docs/handoff/PRD_CHALLENGE.md` связаны из README.

## 7. Журнал плана

| Дата | Изменение |
|---|---|
| 01.11.2026 | Создан план фазы (scope, MoSCoW, риск зависания SSR). |
| 02.11.2026 | План переработан после ревью 7/10: добавлены чек-лист A–D, полная MoSCoW-матрица, 12 рисков с митигацией и проверкой, exit criteria. |
| 02.11.2026 | Закрыты D-1, D-2, D-4, D-6 проверками: `typecheck` 0, `build` 0 (5 маршрутов), скриншот с production-сборки (1440×900, dsf=2, reduced-motion, 2880×1800), `pre-commit.bat` 0. Маршруты `/`, `/email`, `/vacancies`, `/rzhd` — HTTP 200 без ошибок консоли; `/nope` — 404. Открыты D-3, D-5 и AC-4 (карточки при отсутствии конфига). |


