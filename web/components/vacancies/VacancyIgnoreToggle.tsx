"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactElement } from "react";

import { Pressable } from "@/components/ui/Pressable";
import { describeApiFailure, patchVacancy } from "@/lib/api/client";
import { cn } from "@/lib/cn";

export interface VacancyIgnoreToggleProps {
  readonly vacancyId: number;
  readonly isIgnored: boolean;
}

/**
 * Переключение игнора вакансии: `PATCH /api/v1/vacancies/{id}` c `is_ignored`.
 *
 * После успеха вызывается `router.refresh()` — Server Component перечитывает
 * список из PostgreSQL, поэтому счётчики карточек тоже обновляются.
 */
export function VacancyIgnoreToggle({
  vacancyId,
  isIgnored,
}: VacancyIgnoreToggleProps): ReactElement {
  const router = useRouter();
  const [ignored, setIgnored] = useState(isIgnored);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setPending(true);
    setError(null);
    const response = await patchVacancy(vacancyId, { is_ignored: !ignored });
    setPending(false);

    if (!response.ok) {
      setError(describeApiFailure(response.error));
      return;
    }
    setIgnored(response.data.is_ignored);
    router.refresh();
  }

  return (
    <div
      data-testid={`vacancy-ignore-${vacancyId}`}
      data-state={ignored ? "ignored" : "active"}
      className="flex flex-col items-start gap-1 lg:items-end"
    >
      <Pressable
        onClick={toggle}
        disabled={pending}
        aria-busy={pending}
        className={cn(
          "rounded-control border px-2.5 py-1 text-[11px] font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          "disabled:cursor-progress disabled:opacity-60",
          ignored
            ? "border-ok/50 bg-ok/10 text-ok hover:border-ok hover:bg-ok/20"
            : "border-line bg-canvas/60 text-muted hover:border-warn/60 hover:text-warn",
        )}
      >
        {pending ? "Сохраняю…" : ignored ? "Вернуть в поиск" : "Игнорировать"}
      </Pressable>
      {error === null ? null : (
        <span role="alert" className="max-w-56 text-[10px] leading-4 text-danger lg:text-right">
          {error}
        </span>
      )}
    </div>
  );
}
