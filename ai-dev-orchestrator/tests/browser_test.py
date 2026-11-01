"""E2E smoke-тест статус-панели оркестратора (Playwright for Python).

Открывает src/status_panel.html через file://-протокол, проверяет, что панель
отрисована и «горит зелёный» статус, после чего снимает скриншот в
.planning/screenshots/green_e2e_test.png.

Запуск (Windows 11, без Node.js):
    uv venv --python 3.12 .venv
    uv pip install --python .venv\\Scripts\\python.exe -r tests\\requirements-dev.txt
    .\\.venv\\Scripts\\python.exe -m playwright install chromium
    .\\.venv\\Scripts\\python.exe tests\\browser_test.py

Коды выхода: 0 — PASS, 1 — провал проверок, 2 — ошибка Playwright.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, sync_playwright

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
DEFAULT_PANEL: Path = PROJECT_ROOT / "src" / "status_panel.html"
DEFAULT_SCREENSHOT: Path = PROJECT_ROOT / ".planning" / "screenshots" / "green_e2e_test.png"

EXPECTED_TITLE: str = "AI Dev Orchestrator"
EXPECTED_STATUS: str = "green"
VIEWPORT: dict[str, int] = {"width": 1440, "height": 900}
CARD_IDS: tuple[str, ...] = ("core-card", "workers-card", "storage-card", "e2e-card")


def log(message: str) -> None:
    """Печатает сообщение с временной меткой (требование CLAUDE.md).

    Текст намеренно только ASCII: консоли Windows с кодовыми страницами
    cp866/cp1251 иначе показывают кириллицу как мусор.
    """
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}", flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Разбирает аргументы командной строки."""
    parser = argparse.ArgumentParser(
        description="E2E check of status_panel.html via Playwright, screenshot to .planning/screenshots/."
    )
    parser.add_argument(
        "--panel",
        type=Path,
        default=DEFAULT_PANEL,
        help=f"path to HTML panel (default: {DEFAULT_PANEL})",
    )
    parser.add_argument(
        "--screenshot",
        type=Path,
        default=DEFAULT_SCREENSHOT,
        help=f"path to output PNG (default: {DEFAULT_SCREENSHOT})",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=15000,
        help="Playwright operation timeout in milliseconds (default: 15000)",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="launch browser with a visible window (debug)",
    )
    return parser.parse_args(argv)


def verify_panel(page: Page) -> None:
    """Проверяет ключевые элементы панели; при расхождении бросает AssertionError."""
    title: str = page.title()
    assert EXPECTED_TITLE in title, f"unexpected <title>: '{title}'"
    log(f"title: {title}")

    badge = page.locator("#status-badge")
    badge.wait_for(state="visible")

    badge_text: str = badge.inner_text().strip().lower()
    assert badge_text == EXPECTED_STATUS, (
        f"expected badge text '{EXPECTED_STATUS}', got '{badge_text}'"
    )
    log(f"status badge: {badge_text.upper()}")

    badge_status: str | None = badge.get_attribute("data-status")
    assert badge_status == EXPECTED_STATUS, (
        f"expected data-status='{EXPECTED_STATUS}', got '{badge_status}'"
    )

    for card_id in CARD_IDS:
        card = page.locator(f"#{card_id}")
        assert card.count() == 1, f"card '#{card_id}' is missing on the page"
    log("cards: " + ", ".join(CARD_IDS) + " - all present")

    footer_text: str = page.locator("#footer").inner_text().strip()
    assert footer_text, "panel footer is empty"
    log(f"footer: {footer_text}")


def run(panel: Path, screenshot: Path, timeout_ms: int, headless: bool) -> int:
    """Выполняет e2e-сценарий и возвращает код выхода."""
    panel = panel.resolve()
    screenshot = screenshot.resolve()

    if not panel.is_file():
        log(f"FAIL: HTML panel not found: {panel}")
        return 1

    screenshot.parent.mkdir(parents=True, exist_ok=True)
    target_url: str = panel.as_uri()
    log(f"target: {target_url}")
    log(f"headless: {headless}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        try:
            page = browser.new_page(viewport=VIEWPORT)
            page.set_default_timeout(timeout_ms)
            page.on("console", lambda msg: log(f"console[{msg.type}]: {msg.text}"))

            page.goto(target_url, wait_until="load")
            page.wait_for_load_state("networkidle")

            verify_panel(page)

            page.screenshot(path=str(screenshot), full_page=True)
        finally:
            browser.close()

    if not screenshot.is_file() or screenshot.stat().st_size == 0:
        log(f"FAIL: screenshot was not created: {screenshot}")
        return 1

    size_kb: float = screenshot.stat().st_size / 1024
    log(f"screenshot: {screenshot} ({size_kb:.1f} KB)")
    log("RESULT: PASS - e2e green, panel rendered in Chromium")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Точка входа CLI."""
    args = parse_args(argv)
    try:
        return run(
            panel=args.panel,
            screenshot=args.screenshot,
            timeout_ms=args.timeout_ms,
            headless=not args.headed,
        )
    except AssertionError as exc:
        log(f"FAIL: {exc}")
        return 1
    except PlaywrightError as exc:
        log(f"ERROR: {exc}")
        log("hint: install the browser with 'python -m playwright install chromium'")
        return 2


if __name__ == "__main__":
    sys.exit(main())
