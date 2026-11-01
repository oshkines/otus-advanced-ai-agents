"""Локальный mock-вебхук для сквозной проверки sender-скриптов без внешней сети.

Запуск (из корня проекта):
    .\\.venv\\Scripts\\python.exe tests\\mock_webhook.py --port 8765
Затем в другом окне:
    $env:ENV_VK_MAX_URL = "http://127.0.0.1:8765/vk"
    .\\.venv\\Scripts\\python.exe agents\\vk_max_sender.py --now 2026-10-26T12:00:00 "real POST"

Сервер принимает POST, дописывает метод/путь/тело в лог-файл (по умолчанию
``build/mock_webhook.log``) и отвечает ``200 {"ok": true}``.
Остановка: Ctrl+C.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def build_handler(log_path: Path) -> type[BaseHTTPRequestHandler]:
    """Создаёт обработчик, который складывает принятые POST в лог-файл."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - имя задано стандартом http.server
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            record = {"method": "POST", "path": self.path, "body": body}
            with log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            payload = json.dumps({"ok": True, "received": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            """Глушим стандартный лог, чтобы не мешать выводу проверки."""

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(prog="mock_webhook.py", description="Local webhook mock for sender checks.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log", type=Path, default=Path("build") / "mock_webhook.log")
    args = parser.parse_args()

    args.log.parent.mkdir(parents=True, exist_ok=True)
    args.log.write_text("", encoding="utf-8")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), build_handler(args.log))
    print(f"mock webhook listening on http://127.0.0.1:{args.port}/ log={args.log}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
