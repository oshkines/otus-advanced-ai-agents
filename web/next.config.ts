import type { NextConfig } from "next";

/**
 * Конфиг Next.js 15 для трёх сред: локальная Windows-разработка, Vercel и
 * TimeWeb Cloud (Node.js-приложение или Docker).
 *
 * Вариант A (Config-SSR): конфиг ядра читается на сервере через fs.
 * `output` НЕ выставлен в "export" — это оставляет точку расширения до варианта B
 * (Route Handlers в `app/api/dashboard/route.ts`).
 *
 * Совместимость с автодеплоем:
 * - Vercel: обычная сборка (`npm run build`), SSR включён, статические маршруты
 *   (`/overview`) оптимизируются, дашборд идёт как dynamic — `force-dynamic`
 *   стоит на layout группы `(dashboard)`. `outputFileTracingIncludes` заносит
 *   `../config/orchestrator.json` в трейс, без него файл не попадёт в бандл
 *   (конфиг лежит на уровень выше корня приложения).
 * - TimeWeb Cloud: `output: "standalone"` включается только при
 *   `BUILD_STANDALONE=1`, поэтому обычный `next start` продолжает работать.
 *   Для standalone-сборки запускать `node .next/standalone/server.js`; порт
 *   берётся из переменной `PORT` (script `start:prod` без жёсткого `-p`).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Гигиена ответа: сервер не раскрывает фреймворк.
  poweredByHeader: false,
  // Минимальный сервер для Docker/TimeWeb (opt-in, чтобы не ломать next start).
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  // Конфиг лежит вне каталога web/ — при сборке его нужно дотащить в файловый трейс,
  // иначе fs.readFile упадёт с ENOENT (в т.ч. в standalone-сборке).
  outputFileTracingIncludes: {
    "/**": ["../config/orchestrator.json"],
  },
};

export default nextConfig;

