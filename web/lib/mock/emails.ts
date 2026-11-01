/**
 * MOCK: письма с ИИ-вердиктами для страницы `/email`.
 * Заменяется реальными данными из таблицы `processed_emails` (Phase 6: agents/email_watcher.py).
 */
export type EmailVerdict = "apply" | "review" | "ignore" | "spam";

export interface MockEmail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly verdict: EmailVerdict;
  readonly reason: string;
}

export const VERDICT_LABEL: Readonly<Record<EmailVerdict, string>> = {
  apply: "ответить",
  review: "проверить",
  ignore: "в архив",
  spam: "спам",
};

export const MOCK_EMAILS: readonly MockEmail[] = [
  {
    id: "mail-001",
    from: "hr@alfersoft.ru",
    subject: "Стажировка C++ разработчик, зимний набор",
    receivedAt: "2026-10-31 09:12",
    verdict: "apply",
    reason: "Совпадение стека C++20 и дат каникул, дедлайн 05.11",
  },
  {
    id: "mail-002",
    from: "noreply@hh.ru",
    subject: "Новая вакансия по фильтру «Remote, 1C»",
    receivedAt: "2026-10-31 08:40",
    verdict: "review",
    reason: "Требуется проверка вилки и условий релокации",
  },
  {
    id: "mail-003",
    from: "dean@alfersoft.ru",
    subject: "Расписание каникул: подтверждение дат",
    receivedAt: "2026-10-30 18:22",
    verdict: "apply",
    reason: "Даты нужны для планирования мониторинга РЖД",
  },
  {
    id: "mail-004",
    from: "newsletter@devdigest.dev",
    subject: "Дайджест: 12 материалов недели",
    receivedAt: "2026-10-30 12:05",
    verdict: "ignore",
    reason: "Информационная рассылка без задач",
  },
  {
    id: "mail-005",
    from: "promo@crypto-bonus.win",
    subject: "Ваш выигрыш ждёт подтверждения!",
    receivedAt: "2026-10-30 03:17",
    verdict: "spam",
    reason: "Фишинг-паттерн: срочность + внешний домен",
  },
];
