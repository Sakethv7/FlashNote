import json
import threading
from pathlib import Path
from typing import Optional
from state import NoteState

STORE_PATH = Path(__file__).parent / "queue.json"

class QueueStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._store: dict[str, dict] = {}
        self._load()

    def _load(self):
        if STORE_PATH.exists():
            try:
                self._store = json.loads(STORE_PATH.read_text())
            except Exception:
                self._store = {}

    def _save(self):
        STORE_PATH.write_text(json.dumps(self._store, indent=2, default=str))

    def add(self, note: dict):
        with self._lock:
            self._store[note["note_id"]] = note
            self._save()

    def get(self, note_id: str) -> Optional[dict]:
        with self._lock:
            return self._store.get(note_id)

    def update(self, note_id: str, updates: dict):
        with self._lock:
            if note_id in self._store:
                self._store[note_id].update(updates)
                self._save()

    def remove(self, note_id: str):
        with self._lock:
            self._store.pop(note_id, None)
            self._save()

    def list_all(self) -> list[dict]:
        with self._lock:
            return list(self._store.values())

queue_store = QueueStore()
