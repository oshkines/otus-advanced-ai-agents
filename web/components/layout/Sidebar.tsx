"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { buildSidebarLinks, type SidebarLink } from "@/lib/orchestrator/derive";
import type { DashboardNavSection, SectionStatus } from "@/lib/orchestrator/types";

export interface SidebarProps {
  readonly sections: readonly DashboardNavSection[];
  readonly coreName: string;
  readonly coreVersion: string;
  readonly configPath: string | null;
}

/** Индикатор канала: цвет берётся из палитры design.md (success / warning / idle). */
const STATUS_DOT: Readonly<Record<SectionStatus, string>> = {
  active: "bg-success-soft",
  disabled: "bg-idle",
  not_connected: "bg-warning",
};

const STATUS_HINT: Readonly<Record<SectionStatus, string>> = {
  active: "канал активен",
  disabled: "канал выключен",
  not_connected: "воркер не подключён",
};

/**
 * Левый сайдбар навигации (design.md §1 каркас, §2 цвета).
 * Пункты меню строятся из конфига; при отсутствии конфига выводятся
 * заглушки модулей Email / Вакансии / РЖД с янтарным статусом.
 */
export function Sidebar({
  sections,
  coreName,
  coreVersion,
  configPath,
}: SidebarProps): ReactElement {
  const pathname = usePathname();
  const links: readonly SidebarLink[] = buildSidebarLinks(sections);
  const moduleCount = links.filter((link) => link.id !== "overview").length;

  return (
    <nav
      aria-label="Основная навигация"
      data-testid="app-sidebar"
      className="flex w-full shrink-0 flex-col border-b border-border bg-surface lg:min-h-screen lg:w-64 lg:border-r lg:border-b-0"
    >
      <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3.5">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-canvas text-primary"
        >
          <Icon name="rocket" />
        </span>
        <span className="min-w-0">
          <span className="block font-mono text-[11px] leading-4 uppercase tracking-[0.22em] text-muted">
            AI DEV
          </span>
          <span className="block truncate font-mono text-sm font-semibold leading-5 text-ink">
            Navigator
          </span>
        </span>
      </div>

      <div className="px-3 pt-4 pb-1.5">
        <p className="font-mono text-[11px] leading-4 uppercase tracking-[0.18em] text-muted">
          Модули
        </p>
      </div>

      <ul className="flex flex-wrap gap-1 px-2 pb-3 lg:flex-col lg:flex-nowrap">
        {links.map((link) => {
          const isActive = pathname === link.href;
          const hint =
            link.status === null
              ? undefined
              : `${STATUS_HINT[link.status]}${link.stub ? " · заглушка" : ""}`;

          return (
            <li key={link.id} className="min-w-0">
              <Link
                href={link.href}
                data-testid={`nav-item-${link.id}`}
                aria-current={isActive ? "page" : undefined}
                title={hint}
                className={cn(
                  "flex items-center gap-2.5 rounded-control border px-2.5 py-2 text-sm leading-5 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  isActive
                    ? "border-border bg-canvas text-ink shadow-[inset_2px_0_0_0_var(--color-primary)]"
                    : "border-transparent text-muted hover:bg-surface-hover hover:text-ink",
                )}
              >
                <Icon
                  name={link.icon}
                  className={cn("shrink-0", isActive ? "text-primary" : "text-muted")}
                />
                <span className="truncate">{link.label}</span>
                {link.status === null ? null : (
                  <span
                    aria-hidden="true"
                    className={cn("ml-auto size-1.5 shrink-0 rounded-full", STATUS_DOT[link.status])}
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto hidden border-t border-border px-4 py-3 pb-12 lg:block">
        <p className="font-mono text-[11px] leading-4 text-muted">
          модулей: {moduleCount} · v{coreVersion}
        </p>
        <p className="mt-1 truncate font-mono text-[11px] leading-4 text-muted" title={coreName}>
          {coreName}
        </p>
        <p
          className="mt-0.5 truncate font-mono text-[11px] leading-4 text-idle"
          title={configPath ?? "конфиг не найден"}
        >
          {configPath ?? "config: not found"}
        </p>
      </div>
    </nav>
  );
}
