import type { NextConfig } from "next";

/**
 * Вариант A (Config-SSR): конфиг ядра читается на сервере через fs.
 * `output` НЕ выставлен в "export" — это оставляет точку расширения до варианта B
 * (Route Handlers в `app/api/dashboard/route.ts`).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Конфиг лежит вне каталога web/ — при сборке его нужно дотащить в файловый трейс,
  // иначе fs.readFile упадёт с ENOENT (в т.ч. в standalone-сборке).
  outputFileTracingIncludes: {
    "/**": ["../config/orchestrator.json"],
  },
};

export default nextConfig;
