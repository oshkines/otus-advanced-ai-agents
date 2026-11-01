import { translateLabel } from "@/lib/i18n/ru";

import type {
  DashboardNavSection,
  IconName,
  NavItemConfig,
  OrchestratorConfig,
  SectionStatus,
  WorkerConfig,
} from "./types";

/**
 * Резервная навигация: применяется, если в конфиге нет `ui.dashboard.navigation`
 * (обратная совместимость с конфигом v0.1.0).
 */
export const DEFAULT_NAVIGATION: readonly NavItemConfig[] = [
  {
    id: "email",
    label_key: "nav.email",
    icon: "mail",
    order: 10,
    worker_ids: ["email_watcher"],
    storage_table: "processed_emails",
  },
  {
    id: "vacancies",
    label_key: "nav.vacancies",
    icon: "briefcase",
    order: 20,
    worker_ids: ["vacancy_scanner"],
    storage_table: null,
  },
  {
    id: "rzhd",
    label_key: "nav.rzhd",
    icon: "train",
    order: 30,
    worker_ids: ["rzhd_watcher"],
    storage_table: null,
  },
];

const KNOWN_ICONS: readonly IconName[] = ["mail", "briefcase", "train", "grid", "rocket"];

export function normalizeIcon(raw: string): IconName {
  return (KNOWN_ICONS as readonly string[]).includes(raw) ? (raw as IconName) : "grid";
}

export function sectionHref(id: string): string {
  return id === "overview" ? "/" : `/${id}`;
}

/**
 * Статус канала: отсутствие воркера — это `not_connected`, а не ошибка рендера.
 */
export function deriveSectionStatus(
  workers: readonly WorkerConfig[],
  workerIds: readonly string[],
): SectionStatus {
  if (workerIds.length === 0 || workers.length === 0) {
    return "not_connected";
  }
  return workers.some((worker) => worker.enabled) ? "active" : "disabled";
}

/** Превращает `ui.dashboard.navigation` конфига в модель бокового меню и карточек. */
export function deriveNavigation(config: OrchestratorConfig): DashboardNavSection[] {
  const items: readonly NavItemConfig[] =
    config.ui.dashboard !== null && config.ui.dashboard.navigation.length > 0
      ? config.ui.dashboard.navigation
      : DEFAULT_NAVIGATION;

  return [...items]
    .sort((left, right) =>
      left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order,
    )
    .map((item): DashboardNavSection => {
      const workers = config.workers.filter((worker) => item.worker_ids.includes(worker.id));
      return {
        id: item.id,
        label: translateLabel(item.label_key, item.id),
        icon: normalizeIcon(item.icon),
        href: sectionHref(item.id),
        workerIds: item.worker_ids,
        storageTable: item.storage_table,
        workers,
        status: deriveSectionStatus(workers, item.worker_ids),
      };
    });
}

export function findSection(
  sections: readonly DashboardNavSection[],
  id: string,
): DashboardNavSection | null {
  return sections.find((section) => section.id === id) ?? null;
}

export function countEnabledWorkers(config: OrchestratorConfig): number {
  return config.workers.filter((worker) => worker.enabled).length;
}

export function countNotConnectedSections(sections: readonly DashboardNavSection[]): number {
  return sections.filter((section) => section.status === "not_connected").length;
}

/**
 * Пункт бокового меню.
 *
 * `status === null` — служебный пункт без индикатора (Обзор).
 * `stub === true` — заглушка модуля: канал ещё не описан в конфиге,
 * пункт меню всё равно виден (design.md §6, состояние Empty).
 */
export interface SidebarLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  readonly status: SectionStatus | null;
  readonly stub: boolean;
}

export const OVERVIEW_LINK: SidebarLink = {
  id: "overview",
  label: "Обзор",
  href: "/",
  icon: "grid",
  status: null,
  stub: false,
};

/** Заглушки модулей Email / Вакансии / РЖД из резервной навигации. */
export const STUB_SIDEBAR_LINKS: readonly SidebarLink[] = DEFAULT_NAVIGATION.map((item) => ({
  id: item.id,
  label: translateLabel(item.label_key, item.id),
  href: sectionHref(item.id),
  icon: normalizeIcon(item.icon),
  status: "not_connected",
  stub: true,
}));

/**
 * Модель меню: Обзор + каналы из конфига. Если конфиг не прочитан или
 * `ui.dashboard.navigation` пуст — показываем заглушки модулей, чтобы навигация
 * не «исчезала» вместе с конфигом.
 */
export function buildSidebarLinks(sections: readonly DashboardNavSection[]): SidebarLink[] {
  const moduleLinks: readonly SidebarLink[] =
    sections.length === 0
      ? STUB_SIDEBAR_LINKS
      : sections.map((section: DashboardNavSection): SidebarLink => ({
          id: section.id,
          label: section.label,
          href: section.href,
          icon: section.icon,
          status: section.status,
          stub: false,
        }));

  return [OVERVIEW_LINK, ...moduleLinks];
}

/** Общий статус дашборда для карточки Health. */
export function deriveOverallStatus(sections: readonly DashboardNavSection[]): SectionStatus {
  if (sections.some((section) => section.status === "active")) {
    return "active";
  }
  if (sections.some((section) => section.status === "not_connected")) {
    return "not_connected";
  }
  return "disabled";
}
