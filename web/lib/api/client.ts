/**
 * Тонкий типизированный клиент Backend API (FastAPI, `api/main.py`).
 *
 * Зачем свой клиент, а не `fetch` по месту:
 * - единый таймаут (`AbortController`) — страница не «висит», если uvicorn не отвечает;
 * - сетевые ошибки и 5xx НЕ бросают исключение, а возвращают `ApiResult`:
 *   Server Component рендерит fallback и статус `API offline / fallback`;
 * - одна точка правды для базового адреса (`NEXT_PUBLIC_API_URL`).
 *
 * Контракт ошибок сервера: `docs/api_spec.md` §2.2 — `{"detail": {"code", "message"}}`.
 * 422 приходит в «родном» формате FastAPI (`detail: [{loc, msg, type}]`) —
 * его так же разбираем, чтобы показать внятный текст.
 */

import type {
  AiCategory,
  ClassifyPreviewPayload,
  ClassifyPreviewResponse,
  DashboardSummary,
  EmailList,
  EmailStatus,
  HealthResponse,
  MailFolder,
  MailFolderList,
  MailFolderPatchPayload,
  MailFolderSyncResult,
  RzhdTicket,
  RzhdTicketCreatePayload,
  RzhdTicketList,
  ScanMode,
  Vacancy,
  VacancyCreatePayload,
  VacancyList,
  VacancyPatchPayload,
  VacancyStatus,
  WorkFormat,
} from "./types";

/** Адрес API по умолчанию: локальный uvicorn (`--host 127.0.0.1 --port 8000`). */
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

/** Префикс всех ручек (`api/main.py` → `APIRouter(prefix="/api/v1")`). */
export const API_PREFIX = "/api/v1";

/** Текст статуса, который видят страницы при недоступном FastAPI. */
export const API_OFFLINE_LABEL = "API offline / fallback";

/** Бюджет ожидания для Server Components: страница не должна ждать дольше. */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * AI-фича идёт в LLM-каскад: 15 с на запрос × 3 попытки × 2 модели,
 * поэтому клиентский таймаут заметно больше обычного.
 */
export const AI_TIMEOUT_MS = 120_000;

/**
 * Синхронизация папок — одноразовый IMAP LIST (лимит API: 180 с),
 * поэтому кнопка «Обновить папки» ждёт дольше обычного запроса.
 */
export const FOLDER_SYNC_TIMEOUT_MS = 190_000;

export type ApiFailureKind = "offline" | "timeout" | "http" | "invalid";

/** Нормализованная ошибка вызова API (без исключений наружу). */
export interface ApiFailure {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}

/** Дискриминированное объединение: `ok === true` гарантирует наличие `data`. */
export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly latencyMs: number }
  | { readonly ok: false; readonly error: ApiFailure; readonly latencyMs: number };

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiRequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Базовый URL API. Значение приходит из `web/.env.local` (`NEXT_PUBLIC_API_URL`),
 * хвостовые слэши отбрасываются, чтобы не получить `//api/v1`.
 */
export function getApiBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
  const base = raw.length > 0 ? raw : DEFAULT_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

/** Полный URL ручки: `apiEndpoint("/api/v1/health")`. */
export function apiEndpoint(path: string): string {
  const base = getApiBaseUrl();
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** Человекочитаемое объяснение ошибки для UI (ru-RU). */
export function describeApiFailure(failure: ApiFailure): string {
  switch (failure.kind) {
    case "offline":
      return `FastAPI недоступен (${failure.message}). Проверьте, что запущен uvicorn на 127.0.0.1:8000.`;
    case "timeout":
      return `FastAPI не ответил за ${failure.message}. Показан fallback.`;
    case "http":
      return `FastAPI вернул ошибку: ${failure.message}${
        failure.code === null ? "" : ` [${failure.code}]`
      }.`;
    case "invalid":
      return `Некорректный ответ FastAPI: ${failure.message}.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Разбирает конверт ошибки FastAPI: `{"detail": {code, message}}` / строка / массив 422. */
function readErrorEnvelope(
  payload: unknown,
  status: number,
): { readonly code: string | null; readonly message: string } {
  if (isRecord(payload)) {
    const detail = payload.detail;
    if (isRecord(detail)) {
      const code = typeof detail.code === "string" ? detail.code : null;
      const message = typeof detail.message === "string" ? detail.message : `HTTP ${status}`;
      return { code, message };
    }
    if (typeof detail === "string") {
      return { code: null, message: detail };
    }
  }
  if (Array.isArray(payload) && payload.length > 0) {
    const first: unknown = payload[0];
    if (isRecord(first) && typeof first.msg === "string") {
      return { code: null, message: `422 · ${first.msg}` };
    }
  }
  return { code: null, message: `HTTP ${status}` };
}

/**
 * Единая обёртка над `fetch`: JSON, таймаут, нормализация ошибок.
 *
 * Возвращает результат вместо исключения — это и есть «graceful fallback»:
 * страницы решают, что показать при `ok === false`.
 */
async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  const init: RequestInit = {
    method: options.method ?? "GET",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(apiEndpoint(path), init);
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          latencyMs,
          error: {
            kind: "invalid",
            status: response.status,
            code: null,
            message: `ответ не является JSON (HTTP ${response.status})`,
          },
        };
      }
    }

    if (!response.ok) {
      const envelope = readErrorEnvelope(payload, response.status);
      return {
        ok: false,
        latencyMs,
        error: {
          kind: "http",
          status: response.status,
          code: envelope.code,
          message: envelope.message,
        },
      };
    }

    return { ok: true, latencyMs, data: payload as T };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (timedOut) {
      return {
        ok: false,
        latencyMs,
        error: { kind: "timeout", status: null, code: null, message: `${timeoutMs} мс` },
      };
    }
    const reason = error instanceof Error ? error.message : "сетевая ошибка";
    return {
      ok: false,
      latencyMs,
      error: {
        kind: "offline",
        status: null,
        code: null,
        message: `${getApiBaseUrl()} · ${reason}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function withQuery(path: string, params: URLSearchParams): string {
  const suffix = params.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}


// ---------------------------------------------------------------------------
// Системные ручки и дашборд.
// ---------------------------------------------------------------------------
export function fetchHealth(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ApiResult<HealthResponse>> {
  return request<HealthResponse>(`${API_PREFIX}/health`, { timeoutMs });
}

export function fetchDashboardSummary(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<DashboardSummary>> {
  return request<DashboardSummary>(`${API_PREFIX}/dashboard/summary`, { timeoutMs });
}

// ---------------------------------------------------------------------------
// Почтовые папки.
// ---------------------------------------------------------------------------
export interface MailFoldersQuery {
  readonly accountId?: number;
  readonly scanMode?: ScanMode;
  readonly isSelectable?: boolean;
}

export function fetchMailFolders(
  query: MailFoldersQuery = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<MailFolderList>> {
  const params = new URLSearchParams();
  if (query.accountId !== undefined) {
    params.set("account_id", String(query.accountId));
  }
  if (query.scanMode !== undefined) {
    params.set("scan_mode", query.scanMode);
  }
  if (query.isSelectable !== undefined) {
    params.set("is_selectable", String(query.isSelectable));
  }
  return request<MailFolderList>(withQuery(`${API_PREFIX}/mail/folders`, params), { timeoutMs });
}

export function patchMailFolder(
  folderId: number,
  payload: MailFolderPatchPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<MailFolder>> {
  return request<MailFolder>(`${API_PREFIX}/mail/folders/${folderId}`, {
    method: "PATCH",
    body: payload,
    timeoutMs,
  });
}

/**
 * Синхронизирует папки ящика (`mail_worker --sync-folders`).
 *
 * Процесс идёт по IMAP и пишет `mail_folders`, поэтому таймаут — `FOLDER_SYNC_TIMEOUT_MS`;
 * после успеха страница вызывает `router.refresh()` и показывает новый снимок.
 */
export function syncMailFolders(
  timeoutMs = FOLDER_SYNC_TIMEOUT_MS,
): Promise<ApiResult<MailFolderSyncResult>> {
  return request<MailFolderSyncResult>(`${API_PREFIX}/mail/sync-folders`, {
    method: "POST",
    timeoutMs,
  });
}


// ---------------------------------------------------------------------------
// Лента писем: реальные записи таблицы `emails`.
// ---------------------------------------------------------------------------
export interface EmailsQuery {
  readonly limit?: number;
  readonly category?: AiCategory;
  readonly folderId?: number;
  readonly status?: EmailStatus;
}

export function fetchEmails(
  query: EmailsQuery = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<EmailList>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.category !== undefined) {
    params.set("category", query.category);
  }
  if (query.folderId !== undefined) {
    params.set("folder_id", String(query.folderId));
  }
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  return request<EmailList>(withQuery(`${API_PREFIX}/emails`, params), { timeoutMs });
}


// ---------------------------------------------------------------------------
// Вакансии.
// ---------------------------------------------------------------------------
export interface VacanciesQuery {
  readonly status?: VacancyStatus;
  readonly workFormat?: WorkFormat;
  readonly isIgnored?: boolean;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function fetchVacancies(
  query: VacanciesQuery = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<VacancyList>> {
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  if (query.workFormat !== undefined) {
    params.set("work_format", query.workFormat);
  }
  if (query.isIgnored !== undefined) {
    params.set("is_ignored", String(query.isIgnored));
  }
  if (query.q !== undefined) {
    params.set("q", query.q);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set("offset", String(query.offset));
  }
  return request<VacancyList>(withQuery(`${API_PREFIX}/vacancies`, params), { timeoutMs });
}

export function createVacancy(
  payload: VacancyCreatePayload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<Vacancy>> {
  return request<Vacancy>(`${API_PREFIX}/vacancies`, {
    method: "POST",
    body: payload,
    timeoutMs,
  });
}

export function patchVacancy(
  vacancyId: number,
  payload: VacancyPatchPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<Vacancy>> {
  return request<Vacancy>(`${API_PREFIX}/vacancies/${vacancyId}`, {
    method: "PATCH",
    body: payload,
    timeoutMs,
  });
}

/** Мягкое скрытие: `DELETE` на бэкенде выставляет `is_ignored = TRUE`. */
export function hideVacancy(
  vacancyId: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<Vacancy>> {
  return request<Vacancy>(`${API_PREFIX}/vacancies/${vacancyId}`, {
    method: "DELETE",
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Билеты РЖД.
// ---------------------------------------------------------------------------
export interface RzhdTicketsQuery {
  readonly status?: string;
  readonly carType?: string;
  readonly directionFrom?: string;
  readonly directionTo?: string;
  readonly travelDateFrom?: string;
  readonly travelDateTo?: string;
  readonly onlyAvailable?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export function fetchRzhdTickets(
  query: RzhdTicketsQuery = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<RzhdTicketList>> {
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  if (query.carType !== undefined) {
    params.set("car_type", query.carType);
  }
  if (query.directionFrom !== undefined) {
    params.set("direction_from", query.directionFrom);
  }
  if (query.directionTo !== undefined) {
    params.set("direction_to", query.directionTo);
  }
  if (query.travelDateFrom !== undefined) {
    params.set("travel_date_from", query.travelDateFrom);
  }
  if (query.travelDateTo !== undefined) {
    params.set("travel_date_to", query.travelDateTo);
  }
  if (query.onlyAvailable !== undefined) {
    params.set("only_available", String(query.onlyAvailable));
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set("offset", String(query.offset));
  }
  return request<RzhdTicketList>(withQuery(`${API_PREFIX}/rzhd/tickets`, params), { timeoutMs });
}

export function createRzhdTicket(
  payload: RzhdTicketCreatePayload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<RzhdTicket>> {
  return request<RzhdTicket>(`${API_PREFIX}/rzhd/tickets`, {
    method: "POST",
    body: payload,
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// AI-фича: классификация письма/вакансии (LLM + PostgreSQL).
// ---------------------------------------------------------------------------
export function classifyPreview(
  payload: ClassifyPreviewPayload,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<ApiResult<ClassifyPreviewResponse>> {
  return request<ClassifyPreviewResponse>(`${API_PREFIX}/ai/classify-preview`, {
    method: "POST",
    body: payload,
    timeoutMs,
  });
}

