/**
 * Tailwind CSS v4: PostCSS-плагин живёт в отдельном пакете `@tailwindcss/postcss`.
 * `tailwind.config.js` не нужен — тема задаётся директивой `@theme` в `app/globals.css`.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
