/**
 * Подписи интерфейса, адресуемые из конфига через `label_key`.
 *
 * Причина: `config/orchestrator.json` обязан оставаться ASCII-only
 * (проверка 2/3 в pre-commit.bat), поэтому кириллица живёт только здесь.
 */
const RU: Readonly<Record<string, string>> = {
  "nav.overview": "Обзор",
  "nav.email": "Email",
  "nav.vacancies": "Вакансии",
  "nav.rzhd": "РЖД",
};

/**
 * Возвращает подпись по ключу. Если ключ неизвестен — используется id канала
 * в верхнем регистре, чтобы UI никогда не падал из-за конфига.
 */
export function translateLabel(labelKey: string, fallbackId: string): string {
  const label = RU[labelKey];
  if (typeof label === "string" && label.length > 0) {
    return label;
  }
  return fallbackId.toUpperCase();
}
