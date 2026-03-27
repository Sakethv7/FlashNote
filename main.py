import os
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

# Load .env so HF_API_KEY and other secrets are available to all modules
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

from config import settings
from watcher import start_all_watchers


def find_free_port(preferred: int = 8765) -> int:
    """Use the configured port exactly — fail clearly if already in use."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", preferred))
            return preferred
    except OSError:
        raise SystemExit(f"Port {preferred} is already in use. Kill the existing process first.")


def wait_for_server(port: int, timeout: float = 60.0):
    """Wait for server to become ready. Longer timeout for frozen app cold starts."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.3)
    return False


def start_server_and_watchers(port: int):
    from api import app
    server_thread = threading.Thread(
        target=uvicorn.run,
        args=(app,),
        kwargs={"host": "127.0.0.1", "port": port, "log_level": "warning"},
        daemon=True
    )
    server_thread.start()

    watcher_thread = threading.Thread(target=start_all_watchers, daemon=True)
    watcher_thread.start()


def main():
    import sys
    port = find_free_port(settings.port)

    start_server_and_watchers(port)

    if not wait_for_server(port):
        print(f"Server did not start on port {port}")
        return

    url = f"http://127.0.0.1:{port}"

    # --- macOS packaged app: run as a menu bar app ---
    if getattr(sys, "frozen", False):
        try:
            import rumps

            class FlashNoteMenuBar(rumps.App):
                def __init__(self):
                    super().__init__("FlashNote", title="📒 FlashNote")
                    self.url = url
                    self.menu = [
                        rumps.MenuItem("Open FlashNote", callback=self.open_browser),
                        None,
                        rumps.MenuItem("Quit", callback=self.quit_app),
                    ]
                    # Open browser on launch
                    webbrowser.open(self.url)

                def open_browser(self, _):
                    webbrowser.open(self.url)

                def quit_app(self, _):
                    rumps.quit_application()

            FlashNoteMenuBar().run()
            return
        except Exception as e:
            print(f"Menu bar error: {e}")

    # --- Dev mode: just open browser and keep alive ---
    print(f"FlashNote running at {url}")
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Shutting down.")


if __name__ == "__main__":
    main()
