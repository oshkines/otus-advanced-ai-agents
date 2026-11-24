import type { ReactElement } from "react";

import type { MailFolder, MailFolderList } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";

export interface MailFolderChipsProps {
  readonly folders: MailFolderList | null;
  /** Дополнительные классы сетки (например, `max-h-64`). */
  readonly className?: string;
  readonly emptyText?: string;
}

/**
 * Компактный список папок ящика из `GET /api/v1/mail/folders`.
 *
 * Показывает имя, количество сообщений и режим сканирования (`full` / `headers`
 * / `skip`) — этого достаточно, чтобы глазами убедиться, что подтянулись
 * реальные 19 папок `oshkines@mail.ru` из PostgreSQL.
 *
 * `title` на плашке отдаёт сырой IMAP-путь (`raw_name`, modified UTF-7),
 * количество писем и статус наблюдения `SCAN` — детали не занимают сетку.
 */
export function MailFolderChips({
  folders,
  className,
  emptyText = "Список папок недоступен: FastAPI не ответил.",
}: MailFolderChipsProps): ReactElement {
  if (folders === null) {
    return <p className="text-sm text-muted">{emptyText}</p>;
  }

  if (folders.items.length === 0) {
    return <p className="text-sm text-muted">В mail_folders пока нет записей.</p>;
  }

  return (
    <ul
      className={cn(
        "grid grid-cols-1 gap-1 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {folders.items.map((folder) => (
        <li
          key={folder.id}
          title={folderTooltip(folder)}
          className="flex items-baseline justify-between gap-2 rounded-control-sm border border-line/60 bg-canvas/60 px-2 py-1"
        >
          <span className="min-w-0 truncate text-[11px] text-ink">{folder.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {folder.message_count} · {folder.scan_mode}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Подсказка плашки: сырой IMAP-путь, письма, наблюдение `SCAN` и время синхронизации. */
function folderTooltip(folder: MailFolder): string {
  const rawPath = folder.raw_name ?? folder.name;
  const watch = folder.scan_mode === "skip" ? "SCAN: skip (не сканируется)" : `SCAN: ${folder.scan_mode}`;
  return [
    `IMAP: ${rawPath}`,
    `писем: ${folder.message_count} · непрочитанных: ${folder.unread_count}`,
    watch,
    `папка ${folder.is_selectable ? "выбрана" : "не выбрана"}`,
    `синхронизирована: ${formatTimestamp(folder.last_synced_at)}`,
  ].join("\n");
}
