# 🧯 Журнал ошибок и решений (Troubleshooting log)

> **Правило работы с файлом:** встретил ошибку — сначала открой этот файл и найди симптом в оглавлении.
> Проблемы нет — реши её и **допиши запись в конец** по шаблону ниже, обновив оглавление.
> Формат: **Симптом → Причина → Решение → Профилактика**. Записи не удаляем: даже устаревшая
> подсказка экономит время. Файл ведётся вручную и ИИ-агентом (Cline) одинаково.

## 📑 Оглавление

| # | Симптом | Дата |
|---|---|---|
| [001](#001-internal-server-error-на-localhost3000-после-сборки) | `Internal Server Error` на `localhost:3000` после `npm run build` | 2026-11-01 |
| [002](#002-err_connection_refused-на-localhost3000) | `ERR_CONNECTION_REFUSED` на `localhost:3000` (dev-сервер не запущен) | 2026-11-02 |

### 002. ERR_CONNECTION_REFUSED на localhost:3000

- **Дата:** 2026-11-02
- **Где:** браузер → `http://localhost:3000/`, каталог `web/`
- **Симптом:** страница «Не удаётся получить доступ к сайту», код `ERR_CONNECTION_REFUSED`;
  `Get-NetTCPConnection -LocalPort 3000 -State Listen` не возвращает ни одного процесса.
- **Причина:** dev-сервер остановлен (штатно — перед `npm run build`, после production-съёмки на :3100
  или по завершении сессии). Код и конфиг в порядке — порт просто никто не слушает.
- **Решение** (PowerShell, из корня репозитория):

  ```powershell
  Set-Location web
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev > ..\dev.log 2>&1' -WindowStyle Hidden
  Set-Location ..
  curl.exe -s -o NUL -w "%{http_code}" --max-time 60 http://127.0.0.1:3000/   # ожидаем 200
  ```

- **Профилактика:** после любых правок в `web/` поднимать dev и **оставлять его запущенным** до конца
  сессии, чтобы владелец сразу видел результат (`CLAUDE.md` → «Обязательный цикл проверки UI»).
  Гасить только перед `npm run build` (запись 001) — и сразу поднимать обратно.

## 🧩 Шаблон новой записи

````md
### NNN. <короткий симптом>

- **Дата:** YYYY-MM-DD
- **Где:** <сервис / каталог / команда>
- **Симптом:** что именно видно (текст ошибки, код ответа, лог).
- **Причина:** почему это происходит на самом деле (а не «что первым пришло в голову»).
- **Решение:** пошагово, готовые команды PowerShell из корня репозитория.
- **Профилактика:** как не наступить на это снова.
````

## 001. `Internal Server Error` на `localhost:3000` после сборки

- **Дата:** 2026-11-01
- **Где:** `web/` (Next.js 15), `npm run dev` на порту 3000 и параллельно запущенный `npm run build`.
- **Симптом:** браузер на `http://localhost:3000/` показывает голый текст `Internal Server Error`,
  `curl` отдаёт `500`, при этом процесс `node` жив и порт 3000 слушается.
  Прод-сервер на другом порту (`npm run start:e2e`, 3100) в это же время работает нормально.
- **Причина:** `next dev` и `next build` используют **один и тот же каталог `web/.next`**.
  Сборка перезаписывает манифесты и чанки, на которые опирается уже запущенный dev-процесс,
  поэтому он больше не может собрать страницу и отвечает 500 на каждый запрос.
  Код при этом в порядке — «протух» именно dev-инстанс, а не проект.
- **Решение** (PowerShell, из корня репозитория):

  ```powershell
  # 1. остановить процесс, который держит порт 3000
  Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force }

  # 2. удалить смешанные артефакты (прод-сборка + dev)
  Remove-Item -LiteralPath 'web\.next' -Recurse -Force

  # 3. поднять dev заново в фоне, лог — dev.log в корне (он под *.log в .gitignore)
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev > ..\dev.log 2>&1' `
    -WorkingDirectory "$PWD\web" -WindowStyle Hidden

  # 4. проверить: ожидаем 200 и строку "Compiled /" в dev.log
  curl.exe -s -o NUL -w "%{http_code}" --max-time 60 http://127.0.0.1:3000/
  Get-Content 'dev.log' | Select-Object -Last 5
  ```

- **Профилактика:**
  1. Перед `npm run build` всегда останавливать `next dev` (либо собирать в отдельный каталог
     через `distDir` в `web/next.config.ts`).
  2. Скриншоты для README снимать только с прод-сборки: `npm run build` →
     `npm run start:e2e` (порт 3100) → съёмка → остановить процесс. Прод-сборка не мешает dev,
     если dev-сервер уже остановлен.
  3. Если на 3000 снова 500 — не искать баг в коде: сразу повторить шаги 1–3 выше.

## 🔎 Быстрая диагностика окружения

```powershell
# Кто слушает порт (3000 — dev, 3100 — e2e-прод)
Get-NetTCPConnection -LocalPort 3000,3100 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess

# Ответ страницы (200 — норма, 500 — см. запись 001, пусто/000 — сервер не поднят)
curl.exe -s -o NUL -w "%{http_code}" --max-time 60 http://127.0.0.1:3000/

# Проверки фронтенда без запуска сервера
Set-Location web
npm run typecheck        # tsc --noEmit
npm run build            # только при остановленном next dev!
```
