"use client";

import { useEffect, useState, type ReactElement } from "react";

/**
 * Состояние L1 (PRD_CHALLENGE.md §7.2): браузер без сети.
 *
 * Начальное состояние — `false` (онлайн), чтобы серверный и клиентский рендер
 * совпадали. Реальный `navigator.onLine` читается только в `useEffect` —
 * это исключает hydration mismatch.
 */
export function OfflineBanner(): ReactElement | null {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const sync = (): void => {
      setIsOffline(navigator.onLine === false);
    };

    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);

    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (!isOffline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="m-4 flex items-center gap-2 rounded-bento border border-warning/50 bg-warning/10 px-4 py-2 text-xs text-warning lg:m-6 lg:mb-0"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span>Нет сети: действия недоступны, данные остаются на экране.</span>
    </div>
  );
}
