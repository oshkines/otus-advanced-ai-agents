"use client";

import Link from "next/link";
import type { ReactElement } from "react";

export interface RouteErrorProps {
  readonly title: string;
  readonly description: string;
  readonly digest?: string;
  readonly testId: string;
  readonly retryTestId: string;
  readonly onRetry: () => void;
}

/**
 * Состояние L3 (PRD_CHALLENGE.md §7.2): исключение внутри маршрута.
 *
 * Вместо белого экрана — карточка в палитре проекта, причина (digest) и два пути
 * восстановления. Ошибка не скрывается автоматически.
 */
export function RouteError({
  title,
  description,
  digest,
  testId,
  retryTestId,
  onRetry,
}: RouteErrorProps): ReactElement {
  return (
    <section
      role="alert"
      data-testid={testId}
      className="mx-auto mt-6 w-full max-w-2xl rounded-bento border border-danger/60 bg-surface p-6"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        AI DEV NAVIGATOR · ERROR
      </p>
      <h1 className="mt-2 text-2xl font-bold leading-8">{title}</h1>
      <p className="mt-2 text-sm leading-5 text-muted">{description}</p>

      {digest === undefined || digest.length === 0 ? null : (
        <p className="mt-3 break-all font-mono text-xs text-danger">digest: {digest}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          data-testid={retryTestId}
          className="inline-flex items-center rounded-control border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:border-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          Повторить
        </button>
        <Link
          href="/"
          className="inline-flex items-center rounded-control border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-primary/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          На главную
        </Link>
      </div>

      <p className="mt-4 text-xs text-muted">
        Подсказка: подробности — в консоли браузера и в логе Next.js. Маршрут остаётся в адресной
        строке, поэтому после исправления достаточно нажать «Повторить».
      </p>
    </section>
  );
}
