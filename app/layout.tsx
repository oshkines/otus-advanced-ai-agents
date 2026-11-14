import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

import "./globals.css";

import { AuroraBackdrop } from "@/components/layout/AuroraBackdrop";
import { MotionProvider } from "@/components/providers/MotionProvider";

/*
 * Типографика design.md §3. next/font отдаёт self-hosted файлы: внешних
 * CDN-запросов в рантайме нет (важно для корпоративных сетей и TimeWeb Cloud).
 * Subset `cyrillic` обязателен: интерфейс русскоязычный, без него Inter и
 * JetBrains Mono подменялись бы системными шрифтами и ломали моноширинный ритм логов.
 */
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  applicationName: "AI Dev Navigator",
  title: {
    default: "AI Dev Navigator — Dashboard",
    template: "%s — AI Dev Navigator",
  },
  description: "AI Dev Navigator: bento-дашборд оркестратора — Email, Вакансии, РЖД",
  /*
   * Favicon — силуэт корабля Trimaxion (`app/icon.svg`, Next 15 подхватывает его
   * как file-based metadata). Явная запись `icons` фиксирует иконку вкладки:
   * без неё браузер при отсутствии/ошибке файла показывает стандартный «глобус».
   * `shortcut` нужен Chrome/Edge для закладок, `apple` — для iOS-плитки.
   */
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

/** Явный viewport: мобильная ширина без горизонтального скролла (проверка 375 px). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0e17",
  colorScheme: "dark",
};

/**
 * Корневой layout: html/body, шрифтовые переменные, палитра и общий фон.
 *
 * `AppShell` (sidebar + баннеры) сюда намеренно не входит: дашборд живёт в
 * route group `(dashboard)`, а публичная страница `/overview` рендерится без
 * сайдбара. Данные конфига читает layout группы, поэтому корневой layout
 * остаётся статическим.
 */
export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <html lang="ru" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        <MotionProvider>
          <AuroraBackdrop />
          {children}
        </MotionProvider>
      </body>
    </html>
  );
}

