import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from config import load_courses
from pipeline import graph
from queue_store import queue_store

SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DEBOUNCE_SECONDS = 10
MAX_GROUP_SIZE = 5

_watchers: dict = {}
_lock = threading.Lock()

# Debounced auto smart process: keyed by "course::module"
# After any note finishes, wait 30s then run full smart process (consolidate → order).
# If another note in the same module finishes within 30s, the timer resets.
_smart_order_timers: dict[str, threading.Timer] = {}
_smart_order_lock = threading.Lock()


def _run_auto_smart_process(course_name: str, module_name: str):
    """
    Full auto smart process fired after upload debounce (30s):
    Step 1: consolidate (merge duplicates)
    Step 2: smart order (sequence logically)
    """
    import anthropic as _ant, json as _j
    from nodes import consolidate_module_notes
    key = f"{course_name}::{module_name}"
    print(f"[auto-smart] starting for {key}")
    # Clean up the timer entry now that we're executing
    with _smart_order_lock:
        _smart_order_timers.pop(key, None)

    # ── Step 1: Consolidate ──
    try:
        eligible = [
            n for n in queue_store.filter(course_name=course_name, module_name=module_name)
            if n.get("status") in ("in_review", "approved") and n.get("draft_markdown", "").strip()
        ]
        if len(eligible) >= 2:
            actions = consolidate_module_notes(eligible)
            for act in actions:
                if act["action"] == "merge":
                    primary = queue_store.get(act["primary"]) or {}
                    queue_store.update(act["primary"], {
                        "draft_markdown": act["merged_markdown"],
                        "title": act.get("merged_title", "Merged Note"),
                        "status": primary.get("status", "in_review"),
                        "timestamp": __import__("datetime").datetime.now().isoformat(),
                    })
                    for nid in act.get("delete", []):
                        queue_store.remove(nid)
                elif act["action"] == "delete":
                    for nid in act.get("note_ids", []):
                        queue_store.remove(nid)
            print(f"[auto-smart] {key} consolidate done — {len(actions)} actions")
    except Exception as e:
        import traceback
        print(f"[auto-smart] {key} consolidate failed: {e}")
        traceback.print_exc()

    # ── Step 2: Smart Order ──
    try:
        notes = queue_store.filter(course_name=course_name, module_name=module_name)
        notes = [n for n in notes if n.get("status") in ("in_review", "approved") and n.get("draft_markdown", "").strip()]
        if len(notes) < 2:
            return
        summaries = []
        for i, n in enumerate(notes):
            md = (n.get("draft_markdown") or "").strip()
            first_line = next((l.strip() for l in md.splitlines() if l.strip() and not l.startswith("#")), "")
            summaries.append(f"{i}: {n.get('title', 'Untitled')} — {first_line[:150]}")
        prompt = (
            "Below are study notes from a course module. Suggest the best logical reading order "
            "(chronological / conceptual build-up). Return ONLY a JSON array of the original indices "
            "in your suggested order, e.g. [2, 0, 3, 1].\n\nNotes:\n" + "\n".join(summaries)
        )
        client = _ant.Anthropic()
        msg = client.messages.create(
            model="claude-3-haiku-20240307",
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
            timeout=30.0,
        )
        raw = msg.content[0].text.strip()
        start, end = raw.find("["), raw.rfind("]") + 1
        order = _j.loads(raw[start:end])
        if sorted(order) != list(range(len(notes))):
            raise ValueError("Invalid permutation")
        updates = {notes[orig_idx]["note_id"]: {"sequence": seq_pos}
                   for seq_pos, orig_idx in enumerate(order)}
        queue_store.batch_update(updates)
        print(f"[auto-smart] {key} → sequenced {len(notes)} notes")
    except Exception as e:
        print(f"[auto-smart] {key} smart order failed: {e}")


def _schedule_smart_order(course_name: str, module_name: str):
    """Debounce: reset the 30s timer each time a note finishes in this module."""
    key = f"{course_name}::{module_name}"
    with _smart_order_lock:
        existing = _smart_order_timers.get(key)
        if existing:
            existing.cancel()
        t = threading.Timer(30.0, _run_auto_smart_process, args=(course_name, module_name))
        t.daemon = True
        _smart_order_timers[key] = t
        t.start()
    print(f"[auto-smart] scheduled for {key} in 30s")


def _make_initial_state(image_paths: list[str], course, module_name: str = "", user_notes: str = "") -> dict:
    """Factory for the initial NoteState dict passed to the pipeline."""
    return {
        "note_id": str(uuid.uuid4()),
        "image_paths": image_paths,
        "course_name": course.course_name,
        "module_name": module_name,
        "expansion_level": course.expansion_level,
        "user_notes": user_notes,
        "tags": course.tags,
        "extracted_text": "",
        "diagram_descriptions": [],
        "merge_decision": "single",
        "uncertainties": [],
        "search_queries": [],
        "search_results": [],
        "visuals": [],
        "draft_markdown": "",
        "image_embeds": [f"![[{Path(p).name}]]" for p in image_paths],
        "reflection_scores": None,
        "loop_count": 0,
        "status": "processing",
        "title": "Processing...",
        "thumbnail_path": image_paths[0],
        "timestamp": datetime.now().isoformat(),
    }


def _run_pipeline(initial_state: dict):
    """Run the graph pipeline and update queue_store with results."""
    note_id = initial_state["note_id"]
    try:
        result = graph.invoke(initial_state)
        queue_store.update(note_id, {
            "extracted_text": result.get("extracted_text", ""),
            "diagram_descriptions": result.get("diagram_descriptions", []),
            "merge_decision": result.get("merge_decision", "single"),
            "uncertainties": result.get("uncertainties", []),
            "search_queries": result.get("search_queries", []),
            "search_results": result.get("search_results", []),
            "visuals": result.get("visuals", []),
            "draft_markdown": result.get("draft_markdown", ""),
            "title": result.get("title", "Untitled"),
            "reflection_scores": result.get("reflection_scores"),
            "loop_count": result.get("loop_count", 0),
            "status": "in_review",
        })
        # Auto smart-order: debounced 30s after last note in this module finishes
        _schedule_smart_order(
            initial_state.get("course_name", ""),
            initial_state.get("module_name", "")
        )
        return result
    except Exception as e:
        print(f"Pipeline error for note {note_id}: {e}")
        queue_store.update(note_id, {"status": "rejected", "title": f"Error: {str(e)[:50]}"})
        return None


class ScreenshotHandler(FileSystemEventHandler):
    def __init__(self, course):
        self.course = course
        self._pending: set[str] = set()   # set deduplicates duplicate OS events
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=3)
        self._shutdown = threading.Event()

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in SUPPORTED_EXTS:
            return
        with self._lock:
            self._pending.add(str(path))   # add() ignores duplicates
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_SECONDS, self._flush)
            self._timer.start()

    def _flush(self):
        with self._lock:
            batch = list(self._pending)
            self._pending.clear()
            self._timer = None

        if not batch:
            return

        for i in range(0, len(batch), MAX_GROUP_SIZE):
            group = batch[i:i + MAX_GROUP_SIZE]
            self._executor.submit(self._process_group, group)

    def _process_group(self, image_paths: list[str]):
        if self._shutdown.is_set():
            return
        initial_state = _make_initial_state(image_paths, self.course)
        queue_store.add(initial_state)
        result = _run_pipeline(initial_state)
        if result and result.get("merge_decision") == "separate" and len(image_paths) > 1:
            for path in image_paths[1:]:
                self._executor.submit(self._process_group, [path])

    def stop(self):
        self._shutdown.set()
        if self._timer:
            self._timer.cancel()
        self._executor.shutdown(wait=False)


def process_images(image_paths: list[str], course, module_name: str = "", user_notes: str = "") -> str:
    """Queue and process images for a course. Returns note_id. Runs in background thread."""
    initial_state = _make_initial_state(image_paths, course, module_name, user_notes)
    queue_store.add(initial_state)
    threading.Thread(target=_run_pipeline, args=(initial_state,), daemon=True).start()
    return initial_state["note_id"]


def start_all_watchers():
    courses = load_courses()
    for course in courses:
        add_course_watcher(course)

def add_course_watcher(course):
    if not course.folder_path or not course.folder_path.strip():
        return  # skip courses with no watch folder configured
    with _lock:
        if course.id in _watchers:
            return
        folder = Path(course.folder_path)
        folder.mkdir(parents=True, exist_ok=True)
        handler = ScreenshotHandler(course)
        observer = Observer()
        observer.schedule(handler, str(folder), recursive=False)
        observer.start()
        _watchers[course.id] = (observer, handler)

def remove_course_watcher(course_id: str):
    with _lock:
        if course_id not in _watchers:
            return
        observer, handler = _watchers.pop(course_id)
        handler.stop()
        observer.stop()
        observer.join()

def stop_all_watchers():
    for course_id in list(_watchers.keys()):
        remove_course_watcher(course_id)
