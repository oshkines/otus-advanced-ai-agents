"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactElement } from "react";

import { Pressable } from "@/components/ui/Pressable";
import { describeApiFailure, syncMailFolders } from "@/lib/api/client";
import { cn } from "@/lib/cn";

export interface MailFoldersSyncButtonProps {
  readonly className?: string;
  readonly testId?: string;
}

/**
 * Компактная кнопка «Обновить папки» на `/email`.
 *
 * Вызывает `POST /api/v1/mail/sync-folders`: бэкенд запускает штатный режим
 * `mail_worker.py --sync-folders` (IMAP LIST → UPSERT в `mail_folders`) и
 * возвращает счётчики. После ответа `router.refresh()` перерисовывает Server
 * Components — список папок и счётчики приходят уже из новой записи в БД.
 */
export function MailFoldersSyncButton({
  className,
  testId = "mail-folders-sync",
}: MailFoldersSyncButtonProps): ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const disabled = busy || isPending;

  const handleClick = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    setMessage("Синхронизирую папки по IMAP…");

    const result = await syncMailFolders();
    setBusy(false);

    if (!result.ok) {
      setFailed(true);
      setMessage(describeApiFailure(result.error));
      return;
    }

    const data = result.data;
    if (data.status === "ok") {
      setFailed(false);
      setMessage(
        `Готово: папок ${data.folders_total}, сохранено ${data.folders_saved ?? 0} · ${data.duration_ms} мс`,
      );
    } else {
      setFailed(data.status === "error");
      setMessage(
        `Папок ${data.folders_total} · ошибок ${data.failures}${
          data.detail === null ? "" : ` · ${data.detail}`
        }`,
      );
    }

    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
      <Pressable
        data-testid={testId}
        onClick={() => {
          void handleClick();
        }}
        disabled={disabled}
        aria-busy={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-control border border-primary/50 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors",
          "hover:border-primary hover:bg-primary/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          "disabled:cursor-progress disabled:opacity-60",
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", disabled && "animate-pulse")} />
        {disabled ? "Обновляю…" : "Обновить папки"}
      </Pressable>

      {message === null ? null : (
        <p
          role={failed ? "alert" : "status"}
          data-testid={`${testId}-status`}
          className={cn("text-[10px] leading-4", failed ? "text-danger" : "text-muted")}
        >
          {message}
        </p>
      )}
    </div>
  );
}
