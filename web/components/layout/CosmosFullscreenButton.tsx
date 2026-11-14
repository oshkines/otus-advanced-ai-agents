"use client";

import { Maximize2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

/** Подсказка кнопки — и `title`, и `aria-label`: одна строка правды. */
const BUTTON_HINT = "В перспективе: открыть анимацию космоса на весь экран";

/**
 * Кнопка-заглушка «полноэкранный космос» в правом углу шапки.
 *
 * Оформление — строго токены дизайн-системы: `bg-surface` (#161B22), тонкая
 * `border-border`, hover-ступень `surface-hover` и мягкий переход цвета
 * длительностью 200 ms. По клику открывается компактное модальное окно-заглушка
 * в палитре проекта (`bg-canvas` / `bg-surface`) с единственной кнопкой «ОК».
 *
 * Перехвата Ctrl + Scroll нет намеренно: реальный полноэкранный режим ещё не
 * реализован, кнопка только сообщает об этом.
 */
export function CosmosFullscreenButton(): ReactElement {
  const [open, setOpen] = useState(false);
  const okButtonRef = useRef<HTMLButtonElement | null>(null);

  /* Esc закрывает окно, фокус сразу встаёт на «ОК» — клавиатурный сценарий. */
  useEffect(() => {
    if (!open) {
      return;
    }

    okButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        title={BUTTON_HINT}
        aria-label={BUTTON_HINT}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="cosmos-fullscreen-button"
        onClick={() => setOpen(true)}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-muted transition-colors hover:border-primary/50 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Maximize2 size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" />
      </button>

      {open ? (
        <div
          role="presentation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cosmos-fullscreen-title"
            data-testid="cosmos-fullscreen-stub"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-bento border border-border bg-surface p-5 shadow-xl"
          >
            <h2
              id="cosmos-fullscreen-title"
              className="flex items-center gap-2 text-sm font-semibold leading-5 text-ink"
            >
              <Sparkles size={16} strokeWidth={1.6} aria-hidden="true" className="text-primary" />
              Полноэкранный космос
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Режим полноэкранного наблюдения за космосом находится в разработке
            </p>
            <div className="mt-5 flex justify-end">
              <button
                ref={okButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center justify-center rounded-control border border-primary/40 bg-primary/15 px-4 py-1.5 text-sm font-medium text-primary transition-colors hover:border-primary/70 hover:bg-primary/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                ОК
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
