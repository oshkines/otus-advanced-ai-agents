/**
 * Типы DTO Backend API (FastAPI, `api/main.py`).
 *
 * Нормативный контракт — `docs/api_spec.md` §3; здесь его TypeScript-зеркало.
 * Все даты приходят строками ISO 8601 (`datetime`/`date` Pydantic), суммы —
 * числами (`Decimal` сериализуется в JSON как number).
 *
 * Файл сознательно повторяет Pydantic-схемы 1:1 по именам полей: любое
 * расхождение ломает типизацию страниц, а не рантайм.
 */

export type ScanMode = "full" | "headers" | "skip";
export type WorkFormat = "remote" | "hybrid" | "office";
export type VacancyStatus = "new" | "viewed" | "applied" | "rejected";
export type CarType = "coupe" | "platzkart" | "sv" | "sitting" | "luxury";
export type TicketStatus = "watching" | "available" | "booked" | "expired" | "cancelled";
export type AiCategory = "WHITELIST" | "CRITICAL" | "VACANCY" | "SPAM_VALUABLE" | "SPAM";
export type AiPriority = "HIGH" | "LOW";
export type EmailStatus = "new" | "classified" | "notified" | "ignored" | "deleted" | "error";
export type ClassifyKind = "email" | "vacancy";
export type AiProvider = "deepseek" | "openrouter";

/** §3.1 — здоровье PostgreSQL (`/health`, `dashboard.summary.database`). */
export interface DatabaseHealth {
  readonly status: "ok" | "unavailable";
  readonly latency_ms: number | null;
  readonly pool_size: number | null;
  readonly pool_free: number | null;
  readonly target: string | null;
}

/** §3.1 — готовность LLM-провайдера. */
export interface AiProviderHealth {
  readonly provider: AiProvider;
  readonly base_url: string;
  readonly ready: boolean;
  readonly model: string;
  readonly fallback_model: string;
}

/** §3.1 — `GET /api/v1/health`. */
export interface HealthResponse {
  readonly status: "ok" | "degraded";
  readonly version: string;
  readonly generated_at: string;
  readonly database: DatabaseHealth;
  readonly ai: AiProviderHealth;
}

/** §3.2 — агрегаты канала Email. */
export interface MailSummary {
  readonly accounts: number;
  readonly folders_synced: number;
  readonly folders_watched: number;
  readonly folders_skipped: number;
  readonly emails_total: number;
  readonly emails_new: number;
  readonly emails_classified: number;
  readonly last_sync_at: string | null;
}

/** §3.2 — частота тега полезного спама. */
export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

/** §3.2 — одна выжимка `valuable_spam`. */
export interface ValuableSpamItem {
  readonly id: number;
  readonly spam_tag: string | null;
  readonly spam_url: string | null;
  readonly summary: string;
  readonly sender: string;
  readonly subject: string;
  readonly received_at: string;
}

/** §3.2 — сводка полезного спама. */
export interface ValuableSpamSummary {
  readonly total: number;
  readonly last_7_days: number;
  readonly top_tags: readonly TagCount[];
  readonly latest: readonly ValuableSpamItem[];
}

/** §3.2 — сводка вакансий по форматам работы. */
export interface VacancySummary {
  readonly total: number;
  readonly active: number;
  readonly ignored: number;
  readonly by_work_format: Readonly<Record<string, number>>;
  readonly last_published_at: string | null;
}

/** §3.2 — сводка билетов РЖД. */
export interface RzhdSummary {
  readonly total: number;
  readonly watching: number;
  readonly available: number;
  readonly booked: number;
  readonly nearest_travel_date: string | null;
  readonly cheapest_price_rub: number | null;
}

/** §3.2 — действующие лимиты ИИ из `ai_instructions`. */
export interface AiSummary {
  readonly classifier_model: string | null;
  readonly fallback_model: string | null;
  readonly max_tokens: number | null;
  readonly instructions_active: number;
}

/** §3.2 — `GET /api/v1/dashboard/summary` (один ответ на все Bento-карточки). */
export interface DashboardSummary {
  readonly generated_at: string;
  readonly database: DatabaseHealth;
  readonly mail: MailSummary;
  readonly valuable_spam: ValuableSpamSummary;
  readonly vacancies: VacancySummary;
  readonly rzhd: RzhdSummary;
  readonly ai: AiSummary;
}

/** §3.3 — папка IMAP с вычисленным режимом сканирования. */
export interface MailFolder {
  readonly id: number;
  readonly account_id: number;
  readonly name: string;
  readonly raw_name: string | null;
  readonly special_use: string | null;
  readonly is_selectable: boolean;
  readonly scan_mode: ScanMode;
  readonly unread_count: number;
  readonly message_count: number;
  readonly last_synced_at: string;
}

/** §3.3 — `GET /api/v1/mail/folders`. */
export interface MailFolderList {
  readonly items: readonly MailFolder[];
  readonly total: number;
}

/** §3.3 — тело `PATCH /api/v1/mail/folders/{id}` (extra="forbid"). */
export interface MailFolderPatchPayload {
  readonly is_selectable?: boolean;
  readonly scan_mode?: ScanMode;
}

/** §3.3 — итог `POST /api/v1/mail/sync-folders` (`mail_worker --sync-folders`). */
export interface MailFolderSyncResult {
  readonly status: "ok" | "partial" | "error";
  readonly exit_code: number;
  readonly folders_saved: number | null;
  readonly failures: number;
  readonly folders_total: number;
  readonly duration_ms: number;
  readonly detail: string | null;
}

/** §3.7 — письмо из журнала `emails` + имя папки из JOIN с `mail_folders`. */
export interface EmailItem {
  readonly id: number;
  readonly account_id: number;
  readonly folder_id: number | null;
  readonly folder_name: string | null;
  readonly message_id: string | null;
  readonly external_id: string;
  readonly sender: string;
  readonly sender_name: string;
  readonly subject: string;
  readonly received_at: string;
  readonly category: AiCategory | null;
  readonly priority: AiPriority | null;
  readonly ai_summary: string | null;
  readonly spam_tag: string | null;
  readonly spam_url: string | null;
  readonly status: EmailStatus;
  readonly is_seen: boolean;
  readonly is_deleted: boolean;
  readonly ai_model: string | null;
  readonly error_text: string | null;
  readonly processed_at: string | null;
  readonly created_at: string;
}

/** §3.7 — `GET /api/v1/emails`: лента `created_at DESC`. */
export interface EmailList {
  readonly items: readonly EmailItem[];
  readonly total: number;
  readonly limit: number;
}

/** §3.4 — вакансия сканера + UI-атрибуты `work_format` / `is_ignored`. */
export interface Vacancy {
  readonly id: number;
  readonly source: string;
  readonly external_id: string;
  readonly title: string;
  readonly company: string;
  readonly stack: readonly string[];
  readonly tags: readonly string[];
  readonly salary_min: number | null;
  readonly salary_max: number | null;
  readonly currency: string;
  readonly url: string | null;
  readonly published_at: string | null;
  readonly status: VacancyStatus;
  readonly score: number | null;
  readonly work_format: WorkFormat | null;
  readonly is_ignored: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** §3.4 — тело `PATCH /api/v1/vacancies/{id}` (extra="forbid", хотя бы одно поле). */
export interface VacancyPatchPayload {
  readonly status?: VacancyStatus;
  readonly is_ignored?: boolean;
  readonly work_format?: WorkFormat;
  readonly score?: number;
  readonly url?: string;
  readonly title?: string;
  readonly company?: string;
}

/** §3.4 — тело `POST /api/v1/vacancies` (идемпотентный UPSERT). */
export interface VacancyCreatePayload {
  readonly source: string;
  readonly external_id?: string;
  readonly title: string;
  readonly company?: string;
  readonly stack?: readonly string[];
  readonly tags?: readonly string[];
  readonly salary_min?: number;
  readonly salary_max?: number;
  readonly currency?: string;
  readonly url?: string;
  readonly published_at?: string;
  readonly score?: number;
  readonly work_format?: WorkFormat;
  readonly is_ignored?: boolean;
  readonly description?: string;
}

/** §3.4 — страница вакансий. */
export interface VacancyList {
  readonly items: readonly Vacancy[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}


/** §3.5 — наблюдаемый рейс РЖД. */
export interface RzhdTicket {
  readonly id: number;
  readonly direction_from: string;
  readonly direction_to: string;
  readonly travel_date: string;
  readonly train_number: string;
  readonly car_type: CarType;
  readonly seats_available: number;
  readonly price_rub: number | null;
  readonly booking_url: string | null;
  readonly status: TicketStatus;
  readonly passenger_name: string | null;
  readonly trip_window_start: string | null;
  readonly trip_window_end: string | null;
  readonly notified_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** §3.5 — тело `POST /api/v1/rzhd/tickets` (UPSERT по параметрам предложения). */
export interface RzhdTicketCreatePayload {
  readonly direction_from: string;
  readonly direction_to: string;
  readonly travel_date: string;
  readonly train_number?: string;
  readonly car_type: CarType;
  readonly seats_available?: number;
  readonly price_rub?: number;
  readonly booking_url?: string;
  readonly status?: TicketStatus;
  readonly passenger_name?: string;
  readonly trip_window_start?: string;
  readonly trip_window_end?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** §3.5 — страница билетов. */
export interface RzhdTicketList {
  readonly items: readonly RzhdTicket[];
  readonly total: number;
}

/** §3.6 — вердикт модели (5 полей контракта + вычисленный `priority`). */
export interface AiClassification {
  readonly category: AiCategory;
  readonly summary: string;
  readonly spam_tag: string | null;
  readonly spam_url: string | null;
  readonly work_format: WorkFormat | null;
  readonly priority: AiPriority;
}

/** §3.6 — технический отчёт о вызове LLM. */
export interface AiRun {
  readonly provider: AiProvider;
  readonly model: string;
  readonly used_model: string;
  readonly fallback_model: string;
  readonly fallback_used: boolean;
  readonly attempts: number;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly timeout_sec: number;
  readonly latency_ms: number;
  readonly json_mode: boolean;
}

/** §3.6 — идентификаторы сохранённых строк (`null` — запись не создавалась). */
export interface PersistedRecords {
  readonly email_id: number | null;
  readonly valuable_spam_id: number | null;
  readonly vacancy_id: number | null;
}

/** §3.6 — тело `POST /api/v1/ai/classify-preview` (extra="forbid"). */
export interface ClassifyPreviewPayload {
  readonly kind?: ClassifyKind;
  readonly text: string;
  readonly subject?: string;
  readonly sender?: string;
  readonly sender_name?: string;
  readonly vacancy_title?: string;
  readonly company?: string;
  readonly url?: string;
  readonly stack?: readonly string[];
  readonly salary_min?: number;
  readonly salary_max?: number;
  readonly account_id?: number;
  readonly external_id?: string;
  readonly received_at?: string;
  readonly persist?: boolean;
}

/** §3.6 — ответ AI-фичи: вердикт, отчёт о вызове, ссылки на записи в БД. */
export interface ClassifyPreviewResponse {
  readonly kind: ClassifyKind;
  readonly classification: AiClassification;
  readonly ai: AiRun;
  readonly persisted: PersistedRecords;
}

