/**
 * MOCK: сводка по каналам для карточек на обзорной странице.
 *
 * Данные-заглушки: воркеров `email_watcher` и `rzhd_watcher` пока нет (Phase 6),
 * `vacancy_scanner` описан, но `enabled: false`. После подключения SQLite
 * (см. CONTRACT.md, раздел 6.2) значения придут из `data/cache.db`.
 */
export interface ChannelMockSummary {
  readonly primary: string;
  readonly secondary: string;
}

export const CHANNEL_MOCK_SUMMARY: Readonly<Record<string, ChannelMockSummary>> = {
  email: {
    primary: "18 писем",
    secondary: "4 требуют ответа · 2 спам",
  },
  vacancies: {
    primary: "7 вакансий",
    secondary: "C++ · 1C · Remote",
  },
  rzhd: {
    primary: "3 рейса на каникулы",
    secondary: "от 4 820 ₽ · купе есть",
  },
};

export const DEFAULT_CHANNEL_MOCK_SUMMARY: ChannelMockSummary = {
  primary: "нет данных",
  secondary: "канал не подключён",
};

export function mockSummaryFor(channelId: string): ChannelMockSummary {
  return CHANNEL_MOCK_SUMMARY[channelId] ?? DEFAULT_CHANNEL_MOCK_SUMMARY;
}
