import socket
import threading
import time
import webbrowser

import uvicorn
import webview

from config import settings
from watcher import start_all_watchers


def find_free_port(preferred: int = 8765) -> int:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", preferred))
            return preferred
    except OSError:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def wait_for_server(port: int, timeout: float = 10.0):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return False


def main():
    port = find_free_port(settings.port)

    # Start FastAPI in background thread
    from api import app
    server_thread = threading.Thread(
        target=uvicorn.run,
        args=(app,),
        kwargs={"host": "127.0.0.1", "port": port, "log_level": "warning"},
        daemon=True
    )
    server_thread.start()

    # Start file watcher in background thread
    watcher_thread = threading.Thread(target=start_all_watchers, daemon=True)
    watcher_thread.start()

    # Wait for server to be ready
    if not wait_for_server(port):
        print(f"Server did not start on port {port}")
        return

    url = f"http://127.0.0.1:{port}"
    print(f"App running at {url}")

    # Open in pywebview native window
    try:
        window = webview.create_window(
            "Screenshot Notes",
            url,
            width=1200,
            height=800,
            min_size=(800, 600)
        )
        webview.start()
    except Exception as e:
        print(f"pywebview failed ({e}), opening in browser instead")
        webbrowser.open(url)
        # Keep alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
