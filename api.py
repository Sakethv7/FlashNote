import io
import shutil
import socket
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from config import settings, save_settings, load_courses, save_courses, Course
from queue_store import queue_store
from watcher import add_course_watcher, remove_course_watcher, process_images

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

app = FastAPI(title="FlashNote App")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# On startup: recover any notes stuck in "processing" from a previous crashed run,
# and purge stale "rejected" notes left over from before rejection-as-delete was implemented.
@app.on_event("startup")
async def recover_stuck_notes():
    from queue_store import queue_store
    to_delete = []
    for note in queue_store.list_all():
        if note.get("status") == "processing":
            new_status = "in_review" if note.get("draft_markdown", "").strip() else "rejected"
            queue_store.update(note["note_id"], {"status": new_status})
        elif note.get("status") == "rejected":
            # Old rejected notes are no longer useful — remove them on startup
            to_delete.append(note["note_id"])
    for note_id in to_delete:
        queue_store.remove(note_id)
    if to_delete:
        print(f"[startup] Purged {len(to_delete)} stale rejected note(s) from queue.")

# Cache HTML files at startup — they don't change at runtime
_HTML_CACHE = {
    "index":    (STATIC_DIR / "index.html").read_text(),
    "review":   (STATIC_DIR / "review.html").read_text(),
    "settings": (STATIC_DIR / "settings.html").read_text(),
    "upload":   (STATIC_DIR / "upload.html").read_text(),
}


# --- Page routes ---

@app.get("/", response_class=HTMLResponse)
async def index():
    return _HTML_CACHE["index"]


@app.get("/review/{note_id}", response_class=HTMLResponse)
async def review_page(note_id: str):
    return _HTML_CACHE["review"]


@app.get("/settings-page", response_class=HTMLResponse)
async def settings_page():
    return _HTML_CACHE["settings"]


@app.get("/upload", response_class=HTMLResponse)
async def upload_page():
    return _HTML_CACHE["upload"]


@app.get("/api/qr")
async def get_qr_code():
    """Return a QR code PNG for the mobile upload page."""
    import qrcode
    import qrcode.image.pil
    ip = get_local_ip()
    port = settings.port
    url = f"http://{ip}:{port}/upload"
    qr = qrcode.QRCode(box_size=8, border=3,
                        error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#111118", back_color="#ffffff")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png",
                             headers={"Cache-Control": "no-cache"})


@app.get("/api/upload-url")
async def get_upload_url():
    """Return the local network URL for the upload page."""
    ip = get_local_ip()
    return {"url": f"http://{ip}:{settings.port}/upload", "ip": ip, "port": settings.port}


@app.post("/api/upload")
async def upload_photo(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile = File(default=None),   # legacy single-file support
    course_name: str = Form(...),
    module_name: str = Form(default=""),
    user_notes: str = Form(default=""),
    group_size: int = Form(default=1),        # photos per note: 1, 2, or 3
):
    """Receive photos from mobile/desktop, queue them for processing.

    Supports single file (legacy), multiple files, and group_size for
    combining consecutive photos into one note.
    """
    # Normalise: merge legacy single-file param into files list
    all_files = list(files) if files else []
    if file and file.filename:
        all_files.insert(0, file)
    if not all_files:
        raise HTTPException(status_code=400, detail="No files provided")

    # Resolve course
    all_courses = load_courses()
    course = next(
        (c for c in all_courses if c.course_name.lower() == course_name.strip().lower()),
        None
    )
    if not course:
        course = Course(
            id=str(uuid.uuid4()),
            course_name=course_name.strip(),
            folder_path="",
            expansion_level=settings.default_expansion_level,
            tags=[]
        )

    supported_images = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"}
    saved_image_paths: list[str] = []
    note_ids: list[str] = []

    for upload in all_files:
        ext = Path(upload.filename or "photo.jpg").suffix.lower() or ".jpg"
        if ext not in supported_images and ext != ".txt":
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

        contents = await upload.read()

        if ext == ".txt":
            # Text note: skip pipeline, create directly as in_review
            from queue_store import queue_store as _qs
            from datetime import datetime as _dt
            text_content = contents.decode("utf-8", errors="replace")
            note_id = str(uuid.uuid4())
            title = Path(upload.filename).stem[:80] if upload.filename else "Text Note"
            _qs.add({
                "note_id": note_id,
                "title": title,
                "course_name": course.course_name,
                "module_name": module_name.strip(),
                "status": "in_review",
                "draft_markdown": text_content,
                "image_paths": [],
                "thumbnail_path": None,
                "tags": course.tags,
                "expansion_level": course.expansion_level,
                "loop_count": 0,
                "reflection_scores": None,
                "timestamp": _dt.now().isoformat(),
                "search_queries": [],
            })
            note_ids.append(note_id)
        else:
            dest = UPLOADS_DIR / f"{uuid.uuid4()}{ext}"
            dest.write_bytes(contents)
            saved_image_paths.append(str(dest))

    # Group images by group_size and kick off pipeline per group
    gs = max(1, min(int(group_size), 3))
    for i in range(0, len(saved_image_paths), gs):
        group = saved_image_paths[i:i + gs]
        note_id = process_images(group, course, module_name=module_name.strip(), user_notes=user_notes.strip())
        note_ids.append(note_id)

    if not note_ids:
        raise HTTPException(status_code=400, detail="No valid files processed")

    # Legacy single-file callers expect {"status","note_id"}
    if len(note_ids) == 1:
        return {"status": "queued", "note_id": note_ids[0]}
    return {"status": "queued", "note_ids": note_ids, "count": len(note_ids)}


# --- API routes ---

@app.get("/api/queue")
async def list_queue():
    import re as _re
    # Deduplicate by note_id (shouldn't happen but guards against corrupted store)
    seen: set[str] = set()
    unique = []
    for n in queue_store.list_all():
        nid = n.get("note_id")
        if nid and nid not in seen:
            seen.add(nid)
            unique.append(n)
    notes = unique

    def extract_wikilinks(md: str) -> list[str]:
        return list(dict.fromkeys(_re.findall(r'\[\[([^\]]+)\]\]', md or '')))

    return [
        {
            "note_id": n["note_id"],
            "title": n.get("title", "Untitled"),
            "course_name": n.get("course_name", ""),
            "module_name": n.get("module_name", ""),
            "tags": n.get("tags", []),
            "status": n.get("status", ""),
            "timestamp": n.get("timestamp", ""),
            "expansion_level": n.get("expansion_level", "detailed"),
            "loop_count": n.get("loop_count", 0),
            "wikilinks": extract_wikilinks(n.get("draft_markdown", "")),
        }
        for n in sorted(notes, key=lambda x: x.get("timestamp", ""), reverse=True)
    ]


@app.get("/api/queue/{note_id}")
async def get_note(note_id: str):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@app.get("/api/queue/{note_id}/preview")
async def get_note_preview(note_id: str):
    """Return first 300 chars of note markdown for hover preview."""
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    md = note.get("draft_markdown", "")
    return {"preview": md[:300] if md else ""}


@app.get("/api/queue/{note_id}/status")
async def get_note_status(note_id: str):
    """Lightweight endpoint — returns only status, used by the review page poller."""
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"status": note.get("status", "")}


class ApproveBody(BaseModel):
    markdown: Optional[str] = None


def _save_note_to_vault(note: dict, final_md: str) -> Path:
    """Write a note's markdown + assets to the Obsidian vault. Returns the note path."""
    course = note.get("course_name", "General")
    module = note.get("module_name", "").strip()
    vault = Path(settings.obsidian_vault_path)
    note_dir = vault / course / module if module else vault / course
    assets_dir = note_dir / "assets"
    note_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)
    for img_path in note.get("image_paths", []):
        src = Path(img_path)
        try:
            shutil.copy2(str(src), str(assets_dir / src.name))
        except FileNotFoundError:
            print(f"Image missing, skipping: {img_path}")
        final_md = final_md.replace(f"![[{src.name}]]", f"![[assets/{src.name}]]")
    title = note.get("title", "untitled").replace("/", "-").replace("\\", "-")[:80]
    note_path = note_dir / f"{title}.md"
    note_path.write_text(final_md)
    return note_path


# ── Bulk routes MUST come before /{note_id} routes or FastAPI matches "bulk" as a note_id ──

@app.post("/api/queue/bulk/approve")
async def approve_bulk(course_name: str = None, module_name: str = None):
    """Approve all in_review notes matching course and/or module. Single disk write at end."""
    notes = queue_store.filter(course_name=course_name, module_name=module_name, status="in_review")
    approved, failed = 0, 0
    status_updates: dict[str, dict] = {}
    for note in notes:
        try:
            _save_note_to_vault(note, note.get("draft_markdown", ""))
            status_updates[note["note_id"]] = {"status": "approved"}
            approved += 1
        except Exception as e:
            print(f"Bulk approve failed for {note.get('note_id')}: {e}")
            failed += 1
    if status_updates:
        queue_store.batch_update(status_updates)
    return {"status": "done", "approved": approved, "failed": failed}


@app.delete("/api/queue/bulk")
async def delete_bulk(course_name: str = None, module_name: str = None):
    """Delete all notes matching course and/or module."""
    notes = queue_store.filter(course_name=course_name, module_name=module_name)
    for note in notes:
        queue_store.remove(note["note_id"])
    return {"status": "deleted", "count": len(notes)}


class RegenerateBody(BaseModel):
    expansion_level: Optional[str] = None


@app.post("/api/queue/bulk/regenerate")
async def regenerate_bulk(course_name: str = None, module_name: str = None):
    """Re-run the pipeline for all notes matching course and/or module."""
    import threading
    from pipeline import graph

    matched = queue_store.filter(course_name=course_name, module_name=module_name)

    # Mark all as processing in one disk write
    queue_store.batch_update({n["note_id"]: {
        "status": "processing", "loop_count": 1,
        "reflection_scores": None, "draft_markdown": "",
    } for n in matched})

    def _regen(note):
        note_id = note["note_id"]
        result = graph.invoke(queue_store.get(note_id))
        queue_store.update(note_id, {
            "draft_markdown": result.get("draft_markdown", ""),
            "title": result.get("title", note.get("title")),
            "reflection_scores": result.get("reflection_scores"),
            "loop_count": result.get("loop_count", 0),
            "status": "in_review",
        })

    import time
    for i, note in enumerate(matched):
        # Stagger starts by 20s per note to stay under 30k tokens/min rate limit
        delay = i * 20
        def _start(n=note, d=delay):
            if d: time.sleep(d)
            _regen(n)
        threading.Thread(target=_start, daemon=True).start()

    return {"status": "processing", "count": len(matched)}


# ── Per-note routes ──

@app.post("/api/queue/{note_id}/approve")
async def approve_note(note_id: str, body: ApproveBody = None):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    final_md = body.markdown if body and body.markdown else note.get("draft_markdown", "")
    note_path = _save_note_to_vault(note, final_md)
    queue_store.update(note_id, {"status": "approved"})
    return {"status": "approved", "path": str(note_path)}


@app.delete("/api/queue/{note_id}")
async def delete_note(note_id: str):
    """Hard-delete a single note from the queue."""
    if not queue_store.get(note_id):
        raise HTTPException(status_code=404, detail="Note not found")
    queue_store.remove(note_id)
    return {"status": "deleted"}


# reject is an alias for delete
app.post("/api/queue/{note_id}/reject")(delete_note)


@app.post("/api/queue/{note_id}/regenerate")
async def regenerate_note(note_id: str, body: RegenerateBody = None):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    import threading
    from pipeline import graph

    expansion = (body.expansion_level if body and body.expansion_level else note.get("expansion_level", "detailed"))
    queue_store.update(note_id, {
        "status": "processing",
        "expansion_level": expansion,
        "loop_count": 1,
        "reflection_scores": None,
        "draft_markdown": "",
    })

    def run():
        current = queue_store.get(note_id)
        result = graph.invoke(current)
        queue_store.update(note_id, {
            "draft_markdown": result.get("draft_markdown", ""),
            "title": result.get("title", note.get("title")),
            "reflection_scores": result.get("reflection_scores"),
            "loop_count": result.get("loop_count", 0),
            "status": "in_review"
        })

    threading.Thread(target=run, daemon=True).start()
    return {"status": "processing"}


class DraftUpdateBody(BaseModel):
    markdown: str


@app.put("/api/queue/{note_id}/draft")
async def update_draft(note_id: str, body: DraftUpdateBody):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    queue_store.update(note_id, {"draft_markdown": body.markdown})
    return {"status": "saved"}


class TitleUpdateBody(BaseModel):
    title: str


@app.put("/api/queue/{note_id}/title")
async def update_title(note_id: str, body: TitleUpdateBody):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    new_title = body.title.strip() or "Untitled Note"
    queue_store.update(note_id, {"title": new_title})
    return {"status": "saved", "title": new_title}


class ModuleUpdateBody(BaseModel):
    module_name: str


@app.put("/api/queue/{note_id}/module")
async def update_module(note_id: str, body: ModuleUpdateBody):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    queue_store.update(note_id, {"module_name": body.module_name.strip()})
    return {"status": "saved", "module_name": body.module_name.strip()}


class CourseUpdateBody(BaseModel):
    course_name: str


@app.put("/api/queue/{note_id}/course")
async def update_note_course(note_id: str, body: CourseUpdateBody):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    queue_store.update(note_id, {"course_name": body.course_name.strip()})
    return {"status": "saved", "course_name": body.course_name.strip()}


class CourseCreate(BaseModel):
    course_name: str
    folder_path: str
    expansion_level: str = "detailed"
    tags: list = []

class CourseUpdate(BaseModel):
    course_name: str = None
    folder_path: str = None
    expansion_level: str = None
    tags: list = None


@app.get("/api/courses")
def get_courses():
    return [c.__dict__ for c in load_courses()]

@app.post("/api/courses")
def create_course(body: CourseCreate):
    courses = load_courses()
    # Check for duplicate folder path
    for c in courses:
        if c.folder_path == body.folder_path:
            raise HTTPException(status_code=400, detail="Folder path already used by another course")
    new_course = Course(
        id=str(uuid.uuid4()),
        course_name=body.course_name,
        folder_path=body.folder_path,
        expansion_level=body.expansion_level,
        tags=body.tags
    )
    courses.append(new_course)
    save_courses(courses)
    add_course_watcher(new_course)
    return new_course.__dict__

@app.put("/api/courses/{course_id}")
def update_course(course_id: str, body: CourseUpdate):
    courses = load_courses()
    for i, c in enumerate(courses):
        if c.id == course_id:
            old_folder = c.folder_path
            if body.course_name is not None: c.course_name = body.course_name
            if body.folder_path is not None: c.folder_path = body.folder_path
            if body.expansion_level is not None: c.expansion_level = body.expansion_level
            if body.tags is not None: c.tags = body.tags
            courses[i] = c
            save_courses(courses)
            if body.folder_path and body.folder_path != old_folder:
                remove_course_watcher(course_id)
                add_course_watcher(c)
            return c.__dict__
    raise HTTPException(status_code=404, detail="Course not found")

@app.delete("/api/courses/{course_id}")
def delete_course(course_id: str):
    courses = load_courses()
    courses = [c for c in courses if c.id != course_id]
    save_courses(courses)
    remove_course_watcher(course_id)
    return {"status": "deleted"}


@app.get("/api/settings")
async def get_settings():
    return {
        # API keys: report set/unset only — they live in .env, not config.json
        "anthropic_api_key_set": bool(settings.anthropic_api_key),
        "tavily_api_key_set": bool(settings.tavily_api_key),
        "obsidian_vault_path": settings.obsidian_vault_path,
        "default_expansion_level": settings.default_expansion_level,
        "port": settings.port
    }


@app.put("/api/settings")
async def update_settings(data: dict):
    # Strip any API key fields — those must come from .env only
    data.pop("anthropic_api_key", None)
    data.pop("tavily_api_key", None)
    import config as _cfg
    new = save_settings(data)
    # Propagate new values into api.py's own 'settings' binding
    global settings
    settings = new
    return {"status": "saved"}


@app.get("/api/thumbnail/{note_id}")
async def get_thumbnail(note_id: str):
    note = queue_store.get(note_id)
    if not note or not note.get("thumbnail_path"):
        raise HTTPException(status_code=404)
    path = Path(note["thumbnail_path"])
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(str(path))


@app.get("/api/image/{note_id}/{filename}")
async def get_image(note_id: str, filename: str):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404)
    for img_path in note.get("image_paths", []):
        p = Path(img_path)
        if p.name == filename:
            return FileResponse(str(p))
    raise HTTPException(status_code=404)


@app.get("/api/status")
async def status():
    from watcher import _watchers
    notes = queue_store.list_all()
    active = [n for n in notes if n.get("status") not in ("approved", "rejected")]
    return {
        "watcher_running": len(_watchers) > 0,
        "queue_size": len(active),
        "processing_count": sum(1 for n in active if n.get("status") == "processing")
    }
