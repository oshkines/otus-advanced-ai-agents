# Журнал памяти проекта
## Что сделано
- Сформирован этап Discovery в рамках ДЗ-2.
- Базовый стек жестко зафиксирован под Windows 11 (MSVC, CMake), без использования WSL.
- Backend API (ДЗ по FastAPI): спецификация `docs/api_spec.md`, сервер `api/main.py` (порт 8000,
  CORS для `localhost:3000` и стенда, роль `navigator_worker` + RLS), TDD-набор
  `tests/test_api_tdd.py` (31 тест, БД/LLM подменены фейками) — `python -m pytest` → exit code 0.
- AI-фича `POST /api/v1/ai/classify-preview`: строгий Structured Output (Pydantic), бюджет
  `max_tokens` из `ai_instructions` (кап 1024), таймаут 15 с, 3 retry, fallback-модель,
  сохранение в `emails`/`valuable_spam`/`vacancies`.
- Атрибуты API без DDL (роль не владелец схемы): `vacancies.raw -> 'api'` (`is_ignored`,
  `work_format`) и токен `NAV_SCAN:<mode>` в `mail_folders.flags`; миграция `003` — опция владельца.
## Ловушки и ограничения
- Не давать ИИ-агенту Cline трогать файлы `.env`.
- Все токены от Telegram читать строго через переменные окружения Windows.
- Ошибки и их решения ведём в `docs/troubleshooting.md`: при любом сбое сначала смотрим туда, а не ищем решение с нуля.
