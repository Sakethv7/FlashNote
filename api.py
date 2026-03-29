import io
import shutil
import socket
import uuid
from dataclasses import replace as dc_replace
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

from app_paths import DATA_DIR, STATIC_DIR

UPLOADS_DIR = DATA_DIR / "uploads"
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

from starlette.middleware.base import BaseHTTPMiddleware

class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/static/js/") or path.startswith("/static/css/"):
            response.headers["Cache-Control"] = "no-store"
        return response

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.add_middleware(NoCacheStaticMiddleware)

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

def _serve_html(name: str):
    """Read HTML from disk every request (no caching) so edits show immediately."""
    path = STATIC_DIR / f"{name}.html"
    content = path.read_text()
    return HTMLResponse(content=content, headers={"Cache-Control": "no-store"})


# --- Page routes ---

@app.get("/", response_class=HTMLResponse)
async def index():
    return _serve_html("index")


@app.get("/review/{note_id}", response_class=HTMLResponse)
async def review_page(note_id: str):
    return _serve_html("review")


@app.get("/settings-page", response_class=HTMLResponse)
async def settings_page():
    return _serve_html("settings")


@app.get("/upload", response_class=HTMLResponse)
async def upload_page():
    return _serve_html("upload")


@app.get("/library", response_class=HTMLResponse)
async def library_page():
    return _serve_html("library")


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


def _extract_doc_text(contents: bytes, ext: str) -> str:
    """Extract plain text from a document file."""
    if ext == ".pdf":
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(contents))
            text = "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
            return text or "[PDF contained no extractable text]"
        except Exception as e:
            return f"[Failed to extract PDF: {e}]"
    elif ext == ".rtf":
        try:
            from striprtf.striprtf import rtf_to_text
            text = rtf_to_text(contents.decode("utf-8", errors="replace")).strip()
            return text or "[RTF contained no extractable text]"
        except Exception as e:
            return f"[Failed to extract RTF: {e}]"
    else:
        return contents.decode("utf-8", errors="replace")


def _resize_image_for_grouping(path: str, max_px: int = 512) -> bytes:
    """Downscale image to max_px on longest side for cheap grouping call. Returns JPEG bytes."""
    try:
        from PIL import Image as _PILImage
        import io as _io
        img = _PILImage.open(path).convert("RGB")
        w, h = img.size
        scale = min(max_px / w, max_px / h, 1.0)
        if scale < 1.0:
            img = img.resize((int(w * scale), int(h * scale)), _PILImage.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue()
    except Exception:
        # PIL not available or unreadable — return raw bytes (fallback)
        return Path(path).read_bytes()


def _auto_group_images(image_paths: list[str], context_text: str = "") -> list[list[str]]:
    """Use Claude vision to intelligently group images by topic. Returns list of groups."""
    import anthropic, base64, json as _json
    if len(image_paths) <= 1:
        return [[p] for p in image_paths]

    client = anthropic.Anthropic()
    content = []

    # Use small thumbnails (512px) so we don't blow the token budget with many images
    for idx, path in enumerate(image_paths):
        thumb = _resize_image_for_grouping(path, max_px=512)
        data = base64.standard_b64encode(thumb).decode()
        content.append({"type": "text", "text": f"Image {idx}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})

    context_block = ""
    if context_text.strip():
        context_block = (
            f"\n\nCONTEXT DOCUMENT (use this to understand topic order and chronology):\n"
            f"{context_text[:4000]}\n\n"
        )

    target_groups = max(2, len(image_paths) // 3)
    content.append({"type": "text", "text": (
        f"These are {len(image_paths)} screenshots from a single lecture video or course session.{context_block}"
        f"Your job is to group them into approximately {target_groups} study notes (range: {max(2, target_groups-1)}–{target_groups+1}).\n\n"
        "BE AGGRESSIVE about combining. Multiple slides that all support the same concept, theorem, or method "
        "belong in ONE group — even if the visuals look slightly different. "
        "Only create a new group when a genuinely new topic begins (new chapter, new algorithm, new concept).\n\n"
        "Think of it like a textbook: a single section covers several slides, not one per slide.\n\n"
        "Rules:\n"
        "- Every image must appear in exactly one group\n"
        "- Use 0-based indices\n"
        "- Keep consecutive images together (no reordering)\n"
        f"- Aim for {target_groups} groups total — fewer is better than more\n"
        "- A group of 4–5 images is fine; a group of 1 image is only acceptable if the topic is truly isolated\n\n"
        "Return ONLY valid JSON — a list of lists of indices. Example: [[0,1,2],[3,4,5,6],[7,8,9]]"
    )})

    try:
        msg = client.messages.create(
            model="claude-3-5-sonnet-latest",
            max_tokens=1024,
            messages=[{"role": "user", "content": content}],
            timeout=60.0,
        )
        raw = msg.content[0].text.strip()
        print(f"[auto-group] Claude response: {raw[:300]}")
        # Extract JSON array from response
        start = raw.find("[[")
        end = raw.rfind("]]") + 2
        if start == -1 or end < 2:
            raise ValueError(f"No JSON array found in: {raw}")
        groups_idx = _json.loads(raw[start:end])
        result = [[image_paths[i] for i in grp if 0 <= i < len(image_paths)] for grp in groups_idx if grp]
        print(f"[auto-group] {len(image_paths)} images → {len(result)} groups: {[len(g) for g in result]}")
        return result
    except Exception as e:
        print(f"[auto-group] Failed ({e}), falling back to 1 image per note")
        return [[p] for p in image_paths]


@app.post("/api/suggest-placement")
async def suggest_placement(files: list[UploadFile] = File(default=[])):
    """Look at uploaded images and suggest the best matching course + module from existing notes."""
    import anthropic, base64, json as _json, tempfile, os as _os

    # Build course→module map from existing approved notes
    existing = queue_store.list_all()
    structure: dict[str, set] = {}
    for n in existing:
        if n.get("status") != "approved":
            continue
        c = n.get("course_name", "").strip()
        m = n.get("module_name", "").strip()
        if c:
            structure.setdefault(c, set())
            if m:
                structure[c].add(m)

    if not structure:
        return {"course": "", "module": "", "reason": "No existing notes to match against."}

    structure_text = "\n".join(
        f"- {c}: {', '.join(sorted(ms)) if ms else '(no modules yet)'}"
        for c, ms in sorted(structure.items())
    )

    # Save uploaded images to temp files and resize for cheap vision call
    tmp_paths = []
    try:
        for f in files[:3]:  # max 3 images for cost
            ext = (f.filename or "img").split(".")[-1].lower()
            if ext not in ("jpg", "jpeg", "png", "gif", "webp"):
                continue
            data = await f.read()
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}")
            tmp.write(data)
            tmp.close()
            tmp_paths.append(tmp.name)

        if not tmp_paths:
            return {"course": "", "module": "", "reason": "No image files to analyse."}

        content = []
        for path in tmp_paths:
            img_bytes = _resize_image_for_grouping(path, max_px=512)
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(img_bytes).decode()}
            })

        content.append({
            "type": "text",
            "text": (
                "These are study notes/screenshots. Based on their content, which existing course and module do they best fit into?\n\n"
                f"Existing structure:\n{structure_text}\n\n"
                "Reply with JSON only, no explanation: {\"course\": \"<exact course name>\", \"module\": \"<exact module name or empty string>\", \"reason\": \"<one sentence>\"}"
            )
        })

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            messages=[{"role": "user", "content": content}],
            timeout=30.0,
        )
        raw = msg.content[0].text.strip()
        start = raw.find("{")
        end = raw.rfind("}") + 1
        result = _json.loads(raw[start:end])
        return result
    except Exception as e:
        return {"course": "", "module": "", "reason": f"Could not detect: {e}"}
    finally:
        for p in tmp_paths:
            try: _os.unlink(p)
            except: pass


@app.post("/api/upload")
async def upload_photo(
    files: list[UploadFile] = File(default=[]),
    file: UploadFile = File(default=None),   # legacy single-file support
    course_name: str = Form(...),
    module_name: str = Form(default=""),
    user_notes: str = Form(default=""),
    group_size: int = Form(default=1),        # photos per note: 1, 2, or 3
    group_mode: str = Form(default="fixed"),  # "fixed" or "auto"
    expansion_level: str = Form(default=""),  # override course default if set
):
    """Receive photos from mobile/desktop, queue them for processing.

    Supports single file (legacy), multiple files, group_size for
    combining consecutive photos into one note, and group_mode=auto
    for AI-powered intelligent topic grouping.
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
    # Per-upload expansion level override
    valid_levels = {"concise", "detailed", "comprehensive"}
    if expansion_level and expansion_level in valid_levels:
        course = dc_replace(course, expansion_level=expansion_level)

    supported_images = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"}
    supported_docs = {".txt", ".pdf", ".rtf"}
    saved_image_paths: list[str] = []
    context_texts: list[str] = []   # docs used as context, not standalone notes
    note_ids: list[str] = []
    duplicates: list[str] = []

    # Build set of existing image hashes to detect duplicates
    import hashlib as _hashlib
    existing_hashes: set[str] = set()
    for existing_note in queue_store.list_all():
        for img_path in existing_note.get("image_paths", []):
            try:
                existing_hashes.add(_hashlib.md5(Path(img_path).read_bytes()).hexdigest())
            except Exception:
                pass

    for upload in all_files:
        ext = Path(upload.filename or "photo.jpg").suffix.lower() or ".jpg"
        if ext not in supported_images and ext not in supported_docs:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

        contents = await upload.read()

        # Duplicate detection for images
        if ext in supported_images:
            img_hash = _hashlib.md5(contents).hexdigest()
            if img_hash in existing_hashes:
                duplicates.append(upload.filename or "unknown")
                continue  # skip duplicate

        if ext in supported_docs:
            # Extract text and use as context for image note generation
            doc_text = _extract_doc_text(contents, ext)
            fname = Path(upload.filename).stem if upload.filename else "document"
            context_texts.append(f"[From: {fname}]\n{doc_text}")
        else:
            dest = UPLOADS_DIR / f"{uuid.uuid4()}{ext}"
            dest.write_bytes(contents)
            saved_image_paths.append(str(dest))

    # Combine all doc texts into one context block (cap at 8000 chars to avoid token overrun)
    MAX_CONTEXT = 8000
    combined_context = user_notes.strip()
    if context_texts:
        doc_block = "\n\n---\n\n".join(context_texts)
        prefix = f"{combined_context}\n\n[Context documents:]\n" if combined_context else "[Context documents:]\n"
        combined_context = (prefix + doc_block)[:MAX_CONTEXT]

    # If only docs were uploaded with no images, create standalone notes from them
    if not saved_image_paths and context_texts:
        from queue_store import queue_store as _qs
        from datetime import datetime as _dt
        for ctx in context_texts:
            note_id = str(uuid.uuid4())
            title = ctx.split("\n")[0].replace("[From: ", "").replace("]", "")[:80]
            _qs.add({
                "note_id": note_id,
                "title": title,
                "course_name": course.course_name,
                "module_name": module_name.strip(),
                "status": "in_review",
                "draft_markdown": "\n".join(ctx.split("\n")[1:]).strip(),
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

    # Group images and kick off pipeline — with context from docs
    if saved_image_paths:
        if group_mode == "auto" and len(saved_image_paths) > 1:
            import threading
            batch_id = str(uuid.uuid4())[:8]
            _auto_group_status[batch_id] = {"status": "grouping", "total": len(saved_image_paths), "done": 0}

            def _auto_group_and_process(paths, ctx, crs, mod, bid):
                try:
                    grps = _auto_group_images(paths, context_text=ctx)
                    _auto_group_status[bid]["status"] = "processing"
                    _auto_group_status[bid]["groups"] = len(grps)
                    for grp in grps:
                        process_images(grp, crs, module_name=mod, user_notes=ctx)
                        _auto_group_status[bid]["done"] += 1
                    _auto_group_status[bid]["status"] = "done"
                    print(f"[auto-group] batch {bid} complete: {len(grps)} notes created")
                except Exception as e:
                    import traceback
                    print(f"[auto-group] batch {bid} FAILED: {e}\n{traceback.format_exc()}")
                    _auto_group_status[bid] = {"status": "error", "message": str(e)}

            threading.Thread(
                target=_auto_group_and_process,
                args=(saved_image_paths, combined_context, course, module_name.strip(), batch_id),
                daemon=True
            ).start()
            note_ids.append(f"auto-grouping:{batch_id}")
        else:
            gs = max(1, min(int(group_size), 3))
            groups = [saved_image_paths[i:i + gs] for i in range(0, len(saved_image_paths), gs)]
            for group in groups:
                note_id = process_images(group, course, module_name=module_name.strip(), user_notes=combined_context)
                note_ids.append(note_id)

    if not note_ids and not duplicates:
        raise HTTPException(status_code=400, detail="No valid files processed")
    if not note_ids and duplicates:
        return {"status": "skipped", "duplicates": duplicates, "message": f"All {len(duplicates)} image(s) already exist in your queue."}

    # Return batch_id for auto-grouping so UI can poll progress
    auto_batch = next((n.split(":")[1] for n in note_ids if n.startswith("auto-grouping:")), None)
    if auto_batch:
        return {
            "status": "grouping",
            "batch_id": auto_batch,
            "image_count": len(saved_image_paths),
            "message": f"AI is grouping {len(saved_image_paths)} images into notes…",
            "count": len(saved_image_paths),
        }

    dup_msg = f" ({len(duplicates)} duplicate(s) skipped)" if duplicates else ""
    # Legacy single-file callers expect {"status","note_id"}
    if len(note_ids) == 1:
        return {"status": "queued", "note_id": note_ids[0], "duplicates": duplicates}
    return {"status": "queued", "note_ids": note_ids, "count": len(note_ids), "duplicates": duplicates, "message": f"{len(note_ids)} note(s) queued{dup_msg}"}


# In-memory status tracker for auto-grouping batches
_auto_group_status: dict[str, dict] = {}

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
            "timestamp": n.get("timestamp") or datetime.now().isoformat(),
            "expansion_level": n.get("expansion_level", "detailed"),
            "loop_count": n.get("loop_count", 0),
            "sequence": n.get("sequence", None),
            "pipeline_stage": n.get("pipeline_stage", None) if n.get("status") == "processing" else None,
            "error_message": n.get("error_message", None) if n.get("status") == "failed" else None,
            "wikilinks": extract_wikilinks(n.get("draft_markdown", "")),
        }
        for n in sorted(notes, key=lambda x: (x.get("sequence", 9999), x.get("timestamp", "")), reverse=False)
    ]


# ── These exact-path routes MUST be defined before /{note_id} wildcard routes ──

@app.get("/api/upload/group-status/{batch_id}")
async def auto_group_status(batch_id: str):
    """Poll auto-grouping progress by batch_id."""
    return _auto_group_status.get(batch_id, {"status": "unknown"})


# ── Local embedding model (loaded once, reused) ───────────────────────────────
_embed_model = None
def _get_hf_embeddings(texts: list[str]) -> list[list[float]] | None:
    """
    Get embeddings via HuggingFace Inference API (router).
    Falls back to TF-IDF if token lacks inference permissions.
    """
    import os, requests
    hf_key = os.environ.get("HF_API_KEY", "")
    if not hf_key:
        return None

    # Try HF router (new endpoint as of 2025)
    url = "https://router.huggingface.co/hf-inference/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2"
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {hf_key}"},
            json={"inputs": texts, "options": {"wait_for_model": True}},
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) == len(texts):
                print(f"[embed] HF router OK — dim {len(data[0])}")
                return data
        print(f"[embed] HF router {resp.status_code}: {resp.text[:150]} — falling back to TF-IDF")
    except Exception as e:
        print(f"[embed] HF request failed: {e} — falling back to TF-IDF")

    return None


def _tfidf_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Zero-dependency TF-IDF embeddings using sklearn.
    No API, no download — works offline. Good enough for topic clustering.
    """
    from sklearn.feature_extraction.text import TfidfVectorizer
    vec = TfidfVectorizer(max_features=512, stop_words="english", ngram_range=(1, 2))
    mat = vec.fit_transform(texts)
    return mat.toarray().tolist()


def _get_embed_model():
    """Returns None — we use HF Inference API instead of local model."""
    return None


def _group_by_similarity(pool: list[dict], target_groups: int) -> list[list[int]]:
    """
    Local semantic clustering — no API calls.

    Inspired by TurboQuant: compress note content into dense vectors (embeddings),
    then compute cosine similarity matrix. Notes with high similarity get merged.
    Uses AgglomerativeClustering (bottom-up, like TurboQuant's two-stage approach)
    with cosine distance threshold instead of fixed cluster count, so naturally
    similar notes merge and dissimilar ones stay separate.
    """
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.preprocessing import normalize

    if len(pool) < 2:
        return [list(range(len(pool)))]

    def _strip_fm(md: str) -> str:
        if md.startswith("---"):
            end = md.find("---", 3)
            return md[end+3:].strip() if end != -1 else md
        return md

    # Build text representation: title + first 400 chars of body
    texts = []
    for n in pool:
        body = _strip_fm(n.get("draft_markdown", ""))
        texts.append(f"{n.get('title', '')} {body[:400]}")

    # Get embeddings: try HF API first, fall back to TF-IDF (no download needed)
    import numpy as np
    raw_embeddings = _get_hf_embeddings(texts)
    if raw_embeddings is not None:
        print(f"[embed] Using HF semantic embeddings for {len(texts)} notes")
        embeddings = np.array(raw_embeddings, dtype=float)
    else:
        print(f"[embed] Using TF-IDF embeddings for {len(texts)} notes (offline mode)")
        embeddings = np.array(_tfidf_embeddings(texts), dtype=float)

    # L2-normalize so cosine similarity = dot product
    embeddings = normalize(embeddings, norm="l2")

    # Cosine distance threshold: merge if similarity > 0.65 (empirically good for study notes)
    # AgglomerativeClustering with distance_threshold groups without needing fixed n_clusters
    distance_threshold = 0.35  # cosine distance = 1 - similarity; 0.35 ≈ similarity 0.65
    clustering = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=distance_threshold,
        metric="cosine",
        linkage="average",
    )
    labels = clustering.fit_predict(embeddings)

    # If threshold produced too many singleton groups, fall back to fixed target_groups
    unique_labels = set(labels)
    if len(unique_labels) > target_groups * 2:
        clustering = AgglomerativeClustering(
            n_clusters=max(1, target_groups),
            metric="cosine",
            linkage="average",
        )
        labels = clustering.fit_predict(embeddings)
        unique_labels = set(labels)

    groups = {}
    for i, label in enumerate(labels):
        groups.setdefault(int(label), []).append(i)

    return [g for g in groups.values() if len(g) >= 2]


def _claude_with_retry(client, max_retries: int = 5, **kwargs):
    """Call Claude with exponential backoff on 529 overloaded errors."""
    import time, random
    import anthropic as _ant
    kwargs.setdefault("timeout", 120.0)
    for attempt in range(max_retries):
        try:
            return client.messages.create(**kwargs)
        except _ant.APIStatusError as e:
            if e.status_code in (529, 529) and attempt < max_retries - 1:
                delay = (2 ** attempt) + random.random()
                print(f"[claude] Overloaded, retry {attempt+1}/{max_retries} in {delay:.1f}s")
                time.sleep(delay)
            else:
                raise
    raise RuntimeError("Claude API unavailable after retries")


@app.post("/api/queue/smart-merge")
async def smart_merge_notes(course_name: str = None, module_name: str = None):
    """
    Merge related notes using local semantic embeddings for grouping
    (no API call) + Claude with retry for writing the merged note.
    """
    import anthropic as _ant, threading

    pool = [n for n in queue_store.filter(course_name=course_name, module_name=module_name)
            if n.get("status") in ("in_review", "pending", "approved")
            and n.get("draft_markdown")]

    if len(pool) < 2:
        return {"status": "skipped", "message": "Need at least 2 notes with content to merge."}

    target_groups = max(1, len(pool) // 3)
    merge_id = str(uuid.uuid4())[:8]
    _auto_group_status[merge_id] = {"status": "merging", "total": len(pool), "done": 0}

    def _do_merge(pool, mid):
        try:
            # STEP 1: Group by semantic similarity — purely local, zero API calls
            groups_idx = _group_by_similarity(pool, target_groups)
            print(f"[smart-merge] {len(pool)} notes → {len(groups_idx)} merge group(s)")

            if not groups_idx:
                _auto_group_status[mid] = {"status": "done", "message": "Notes are too dissimilar to merge."}
                return

            client = _ant.Anthropic()

            def strip_fm(md):
                if md.startswith("---"):
                    end = md.find("---", 3)
                    return md[end+3:].strip() if end != -1 else md
                return md

            # STEP 2: For each group, ask Claude to write one merged note (with retry)
            for grp in groups_idx:
                primary = pool[grp[0]]
                titles = [pool[i].get("title", f"Note {i}") for i in grp]
                images = []
                for i in grp:
                    images.extend(pool[i].get("image_paths", []))
                bodies = [strip_fm(pool[i].get("draft_markdown", "")) for i in grp if pool[i].get("draft_markdown")]

                merge_prompt = (
                    f"You are merging {len(bodies)} study notes that cover overlapping topics into ONE comprehensive, well-structured note.\n\n"
                    "Source notes:\n"
                    + "\n\n---\n\n".join(f"**{titles[j]}**\n{bodies[j]}" for j in range(len(bodies)))
                    + "\n\n"
                    "Write a single cohesive study note that:\n"
                    "- Has a concise title summarising the combined topic\n"
                    "- Eliminates redundancy but preserves all unique insights\n"
                    "- Uses clear headings, bullet points, and wikilinks [[Like This]]\n"
                    "- Includes a Mermaid diagram if the topic benefits from one\n\n"
                    "Return ONLY the merged markdown starting with YAML frontmatter:\n"
                    "---\ntitle: <merged title>\n---\n\n<body>"
                )

                merge_msg = _claude_with_retry(
                    client,
                    model="claude-3-haiku-20240307",
                    max_tokens=4096,
                    messages=[{"role": "user", "content": merge_prompt}]
                )
                merged_md = merge_msg.content[0].text.strip()

                merged_title = " + ".join(titles)
                if merged_md.startswith("---"):
                    fm_end = merged_md.find("---", 3)
                    if fm_end != -1:
                        for line in merged_md[3:fm_end].splitlines():
                            if line.lower().startswith("title:"):
                                merged_title = line.split(":", 1)[1].strip().strip('"')
                                break

                new_id = str(uuid.uuid4())[:8]
                queue_store.add({
                    "note_id": new_id,
                    "image_paths": images,
                    "course_name": primary.get("course_name"),
                    "module_name": primary.get("module_name"),
                    "title": merged_title,
                    "status": "in_review",
                    "pipeline_stage": None,
                    "merged_from": [pool[i].get("note_id") for i in grp],
                    "draft_markdown": merged_md,
                })
                for i in grp:
                    try: queue_store.remove(pool[i]["note_id"])
                    except: pass
                _auto_group_status[mid]["done"] += 1

            _auto_group_status[mid]["status"] = "done"
        except Exception as e:
            import traceback
            print(f"[smart-merge] {e}\n{traceback.format_exc()}")
            _auto_group_status[mid] = {"status": "error", "message": str(e)}

    threading.Thread(target=_do_merge, args=(pool, merge_id), daemon=True).start()
    return {"status": "merging", "merge_id": merge_id, "notes_in_pool": len(pool), "target_groups": target_groups}


@app.post("/api/queue/smart-order")
async def smart_order_notes(course_name: str = None, module_name: str = None):
    """Use Claude to suggest a logical reading order for notes in a module/course."""
    import anthropic as _ant, json as _j
    notes = queue_store.filter(course_name=course_name, module_name=module_name)
    notes = [n for n in notes if n.get("status") in ("in_review", "approved") and n.get("draft_markdown", "").strip()]
    if len(notes) < 2:
        return {"status": "skipped", "reason": "Need at least 2 notes with content."}

    # Build a compact list of titles + 200-char previews
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
    try:
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
        # Validate: must be a permutation of 0..len-1
        if sorted(order) != list(range(len(notes))):
            raise ValueError("Invalid permutation")
        # Save sequence to each note
        updates = {notes[orig_idx]["note_id"]: {"sequence": seq_pos}
                   for seq_pos, orig_idx in enumerate(order)}
        queue_store.batch_update(updates)
        ordered_titles = [notes[i].get("title", "Untitled") for i in order]
        return {"status": "done", "order": order, "titles": ordered_titles}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.put("/api/queue/reorder")
async def manual_reorder(body: dict):
    """Save a manual reorder. Body: {note_ids: [id1, id2, ...]} in desired order."""
    note_ids = body.get("note_ids", [])
    updates = {nid: {"sequence": i} for i, nid in enumerate(note_ids)}
    queue_store.batch_update(updates)
    return {"status": "done", "count": len(note_ids)}


@app.get("/api/queue/consolidate/status")
async def consolidate_status_early(course_name: str = None, module_name: str = None):
    """Lightweight poll endpoint — returns whether a consolidation is running for this scope."""
    key = f"{course_name or ''}::{module_name or ''}"
    job = _consolidation_jobs.get(key)
    if job and job.get("status") in ("done", "error"):
        _consolidation_jobs.pop(key, None)
    return job if job else {"status": "idle"}


@app.get("/api/queue/{note_id}")
async def get_note(note_id: str):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@app.get("/api/queue/{note_id}/preview")
async def get_note_preview(note_id: str):
    """Return first 300 chars of note markdown for hover preview, frontmatter stripped."""
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    import re as _re
    md = (note.get("draft_markdown") or "").strip()
    # Strip YAML frontmatter robustly — handles missing closing --- too
    md = _re.sub(r'^---\s*\n[\s\S]*?\n---\s*\n?', '', md).lstrip()
    # Also strip any leftover frontmatter lines (no closing ---)
    if md.startswith("---"):
        md = _re.sub(r'^---[\s\S]*', '', md).lstrip()
    # Strip heading lines so preview starts with prose
    lines = md.splitlines()
    body_lines = [l.strip() for l in lines if l.strip() and not l.startswith("#")]
    preview = " ".join(body_lines).strip()[:300]
    return {"preview": preview}


@app.get("/api/queue/{note_id}/status")
async def get_note_status(note_id: str):
    """Lightweight endpoint — returns only status, used by the review page poller."""
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"status": note.get("status", "")}


class ApproveBody(BaseModel):
    markdown: Optional[str] = None


def _resolve_vault_for_note(note: dict) -> tuple[Path, bool]:
    """Return (vault_path, is_per_course) for a note.

    Priority: course-level vault_path > global obsidian_vault_path.
    When a per-course vault is set, notes are stored as:
        {course_vault}/{module}/{title}.md     (no extra course subfolder)
    When using the global vault:
        {global_vault}/{course}/{module}/{title}.md
    """
    course_name = note.get("course_name", "")
    all_courses = load_courses()
    course_obj = next(
        (c for c in all_courses if c.course_name.lower() == course_name.lower()),
        None
    )
    if course_obj and course_obj.vault_path:
        return Path(course_obj.vault_path), True
    if not settings.obsidian_vault_path:
        raise HTTPException(status_code=400, detail="No vault path configured. Set one in Settings.")
    return Path(settings.obsidian_vault_path), False


def _save_note_to_vault(note: dict, final_md: str) -> Path:
    """Write a note's markdown + assets to the Obsidian vault. Returns the note path."""
    course_name = note.get("course_name", "General")
    module = note.get("module_name", "").strip()

    vault, is_per_course = _resolve_vault_for_note(note)

    # Per-course vault: {vault}/{module}/{title}.md  (vault IS the course folder)
    # Global vault:     {vault}/{course}/{module}/{title}.md
    if is_per_course:
        note_dir = vault / module if module else vault
    else:
        note_dir = vault / course_name / module if module else vault / course_name

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


# ── Consolidate + Bulk routes MUST come before /{note_id} routes ──

# In-memory tracker for running consolidation jobs
# key: "course_name::module_name", value: {status, message, count}
_consolidation_jobs: dict[str, dict] = {}


@app.post("/api/queue/consolidate")
async def consolidate_notes_endpoint(course_name: str = None, module_name: str = None):
    """Run LLM redundancy-check + consolidation for a course/module."""
    import threading
    from nodes import consolidate_module_notes

    all_notes = queue_store.filter(course_name=course_name, module_name=module_name)
    eligible = [
        n for n in all_notes
        if n.get("status") in ("in_review", "approved") and n.get("draft_markdown", "").strip()
    ]

    if len(eligible) < 2:
        return {
            "status": "skipped",
            "reason": f"Need at least 2 notes with content — found {len(eligible)}.",
            "count": len(eligible),
        }

    job_key = f"{course_name or ''}::{module_name or ''}"
    _consolidation_jobs[job_key] = {
        "status": "running",
        "message": f"Analysing {len(eligible)} notes for overlap…",
        "count": len(eligible),
    }

    def _run():
        try:
            _consolidation_jobs[job_key]["message"] = "Claude is reviewing notes for redundancy…"
            actions = consolidate_module_notes(eligible)
            merged_count = deleted_count = kept_count = 0
            _consolidation_jobs[job_key]["message"] = "Applying changes…"
            for act in actions:
                if act["action"] == "merge":
                    primary = queue_store.get(act["primary"]) or {}
                    queue_store.update(act["primary"], {
                        "draft_markdown": act["merged_markdown"],
                        "title": act.get("merged_title", "Merged Note"),
                        "status": primary.get("status", "in_review"),
                        "timestamp": datetime.now().isoformat(),
                    })
                    for nid in act.get("delete", []):
                        queue_store.remove(nid)
                        deleted_count += 1
                    merged_count += 1
                elif act["action"] == "delete":
                    for nid in act.get("note_ids", []):
                        queue_store.remove(nid)
                        deleted_count += 1
                else:
                    kept_count += len(act.get("note_ids", []))
            result_msg = f"Done — {merged_count} merged, {deleted_count} removed, {kept_count} unchanged"
            print(f"[consolidate] {result_msg}")
            _consolidation_jobs[job_key] = {
                "status": "done",
                "message": result_msg,
                "merged": merged_count,
                "deleted": deleted_count,
                "kept": kept_count,
            }
        except Exception as e:
            print(f"[consolidate] Failed: {e}")
            _consolidation_jobs[job_key] = {"status": "error", "message": str(e)}

    threading.Thread(target=_run, daemon=True).start()
    scope = f'"{module_name}"' if module_name else f'course "{course_name}"'
    return {
        "status": "processing",
        "count": len(eligible),
        "message": f"Consolidating {len(eligible)} notes in {scope}…",
        "job_key": job_key,
    }


@app.post("/api/queue/bulk/approve")
async def approve_bulk(course_name: str = None, module_name: str = None):
    """Approve all in_review notes matching course and/or module. Single disk write at end."""
    notes = queue_store.filter(course_name=course_name, module_name=module_name, status="in_review")
    approved, failed = 0, 0
    status_updates: dict[str, dict] = {}
    for note in notes:
        try:
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
        try:
            result = graph.invoke(queue_store.get(note_id))
            queue_store.update(note_id, {
                "draft_markdown": result.get("draft_markdown", ""),
                "title": result.get("title", note.get("title")),
                "reflection_scores": result.get("reflection_scores"),
                "loop_count": result.get("loop_count", 0),
                "status": "in_review",
                "error_message": None,
                "pipeline_stage": None,
            })
        except Exception as e:
            import traceback
            print(f"[pipeline] Note {note_id} failed: {e}\n{traceback.format_exc()}")
            queue_store.update(note_id, {
                "status": "failed",
                "error_message": str(e)[:300],
                "pipeline_stage": None,
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
    queue_store.update(note_id, {"status": "approved", "draft_markdown": final_md})
    return {"status": "approved"}


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
        try:
            result = graph.invoke(current)
            queue_store.update(note_id, {
                "draft_markdown": result.get("draft_markdown", ""),
                "title": result.get("title", note.get("title")),
                "reflection_scores": result.get("reflection_scores"),
                "loop_count": result.get("loop_count", 0),
                "status": "in_review",
                "error_message": None,
                "pipeline_stage": None,
            })
        except Exception as e:
            import traceback
            print(f"[pipeline] Note {note_id} failed: {e}\n{traceback.format_exc()}")
            queue_store.update(note_id, {
                "status": "failed",
                "error_message": str(e)[:300],
                "pipeline_stage": None,
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
    folder_path: str = ""
    expansion_level: str = "detailed"
    tags: list = []
    vault_path: str = ""   # per-course Obsidian output vault (empty = use global)

class CourseUpdate(BaseModel):
    course_name: str = None
    folder_path: str = None
    expansion_level: str = None
    tags: list = None
    vault_path: str = None  # per-course Obsidian output vault


@app.get("/api/courses")
def get_courses():
    return [c.__dict__ for c in load_courses()]

@app.post("/api/courses")
def create_course(body: CourseCreate):
    courses = load_courses()
    new_course = Course(
        id=str(uuid.uuid4()),
        course_name=body.course_name,
        folder_path=body.folder_path,
        expansion_level=body.expansion_level,
        tags=body.tags,
        vault_path=body.vault_path or "",
    )
    courses.append(new_course)
    save_courses(courses)
    if new_course.folder_path:
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
            if body.vault_path is not None: c.vault_path = body.vault_path
            courses[i] = c
            save_courses(courses)
            if body.folder_path and body.folder_path != old_folder:
                remove_course_watcher(course_id)
                if c.folder_path:
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


@app.post("/api/vault/resync")
async def resync_vault(course_name: str = None):
    """Re-export all approved notes to the current vault path.

    Works for any vault path — creates folders automatically.
    Triggered automatically when the vault path is changed in settings.
    Optionally filter to a single course with ?course_name=.
    """
    vault = Path(settings.obsidian_vault_path)
    vault.mkdir(parents=True, exist_ok=True)

    notes = queue_store.filter(course_name=course_name, status="approved")
    ok, failed = 0, []
    for note in notes:
        try:
            _save_note_to_vault(note, note.get("draft_markdown", ""))
            ok += 1
        except Exception as e:
            failed.append({"note_id": note["note_id"], "title": note.get("title"), "error": str(e)})
    print(f"[resync] vault={settings.obsidian_vault_path} — {ok} synced, {len(failed)} failed")
    return {"status": "done", "resynced": ok, "failed": len(failed), "errors": failed}


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
    return FileResponse(str(path), headers={"Cache-Control": "public, max-age=86400, immutable"})


@app.get("/api/image/{note_id}/{filename}")
async def get_image(note_id: str, filename: str):
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404)
    for img_path in note.get("image_paths", []):
        p = Path(img_path)
        if p.name == filename:
            return FileResponse(str(p), headers={"Cache-Control": "public, max-age=86400, immutable"})
    raise HTTPException(status_code=404)


@app.get("/api/library")
async def library_list():
    """Return all approved notes for the library sidebar."""
    notes = queue_store.list_all()
    result = []
    for n in notes:
        if n.get("status") != "approved":
            continue
        result.append({
            "note_id": n.get("note_id"),
            "title": n.get("title", "Untitled"),
            "course_name": n.get("course_name", ""),
            "module_name": n.get("module_name", ""),
            "tags": n.get("tags", []),
            "timestamp": n.get("timestamp"),
            "sequence": n.get("sequence"),
        })
    # Sort by course → module → sequence/title
    result.sort(key=lambda n: (
        n.get("course_name") or "",
        n.get("module_name") or "",
        n.get("sequence") if n.get("sequence") is not None else 9999,
        n.get("title") or "",
    ))
    return result


@app.get("/api/library/{note_id}")
async def library_note(note_id: str):
    """Return full note data for the library reader."""
    note = queue_store.get(note_id)
    if not note or note.get("status") != "approved":
        raise HTTPException(status_code=404, detail="Note not found")
    return {
        "note_id": note.get("note_id"),
        "title": note.get("title", "Untitled"),
        "course_name": note.get("course_name", ""),
        "module_name": note.get("module_name", ""),
        "tags": note.get("tags", []),
        "timestamp": note.get("timestamp"),
        "draft_markdown": note.get("draft_markdown", ""),
        "image_paths": note.get("image_paths", []),
        "wikilinks": note.get("wikilinks", []),
    }


@app.get("/api/image-raw/{note_id}")
async def get_image_raw(note_id: str, idx: int = 0):
    """Return original image for library lightbox."""
    note = queue_store.get(note_id)
    if not note:
        raise HTTPException(status_code=404)
    paths = note.get("image_paths", [])
    if idx >= len(paths):
        raise HTTPException(status_code=404)
    p = Path(paths[idx])
    if not p.exists():
        raise HTTPException(status_code=404)
    return FileResponse(str(p), headers={"Cache-Control": "public, max-age=86400, immutable"})


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
