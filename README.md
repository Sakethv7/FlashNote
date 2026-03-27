# FlashNote

> Local-first AI note processing. Drop screenshots → get structured, searchable notes — reviewed and read entirely in-app.

![FlashNote UI](https://img.shields.io/badge/status-active-brightgreen) ![Python](https://img.shields.io/badge/python-3.11+-blue) ![Claude](https://img.shields.io/badge/AI-Claude%20Sonnet-orange) ![LangGraph](https://img.shields.io/badge/pipeline-LangGraph-purple)

---

## Architecture

![FlashNote Architecture](https://s3-alpha.figma.com/thumbnails/2361f4c2-c329-4bde-a14f-dcb1fbbe5136?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAQ4GOSFWC6RGVDPLF%2F20260327%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20260327T052348Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=8d4ed7c3744e3837110cd13fdde909dd5e300d9e42bc16b17127fca52cdb19a3)

> [Edit diagram in FigJam](https://www.figma.com/online-whiteboard/create-diagram/5bcb7881-9398-4b5c-870d-6cada24d5998?utm_source=claude&utm_content=edit_in_figjam)

```
Screenshots / PDFs / RTFs
         ↓
  Watcher  +  Upload API
         ↓
      queue.json
         ↓
  LangGraph Pipeline (6 nodes)
  Intake → Uncertainty → Visuals → Draft → Reflect → Finalize
         ↓
  Library View  ·  Queue View  ·  Graph View
```

---

## What it does

1. **Capture** — Upload photos from your phone (QR code) or drag-and-drop from desktop. PDFs/RTFs are used as AI context.
2. **Process** — 6-node LangGraph pipeline: extract → search gaps → generate visuals → write draft → reflect → finalize
3. **Review** — Approve, reject, or regenerate notes in the Queue view. Keyboard shortcuts: `A` approve, `R` regen, `Delete` reject.
4. **Read** — Library view: browse all approved notes by course/module, search, read rendered markdown with mermaid diagrams.

---

## Features

- **Phone upload via QR code** — scan once, shoot up to 15 photos per session
- **Smart Merge** — AI consolidates related notes in the same module into one
- **Smart Order** — AI sequences notes by topic logic, manual ↑↓ reorder
- **Bulk actions** — multi-select checkboxes, approve/delete/move in batch
- **Graph view** — force-directed knowledge map; click wikilink nodes to search
- **Library view** — in-app reader, no Obsidian needed
- **Duplicate detection** — MD5 hash skip on re-upload
- **Pipeline stage labels** — live progress on each note row
- **Error visibility** — failed notes show error + retry button
- **Undo delete** — 5-second undo window before hard delete
- **Desktop app** — `FlashNote.app` starts server + opens browser on click
- **Dark mode** — Claude/Anthropic colour palette

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/Sakethv7/FlashNote.git
cd FlashNote
pip install -r requirements.txt
```

### 2. Configure API keys

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=your_key_here      # required — console.anthropic.com
TAVILY_API_KEY=your_key_here         # required — tavily.com (free tier works)
```

### 3. Run

```bash
python main.py
```

Opens at `http://localhost:8765`. Scan the QR code on your phone to upload photos wirelessly.

---

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a full pipeline diagram and component breakdown.

---

## Folder structure

```
FlashNote/
├── api.py              # FastAPI server — all HTTP endpoints
├── main.py             # Entry point (starts uvicorn + optional pywebview)
├── pipeline.py         # LangGraph graph definition
├── nodes.py            # 5 pipeline nodes (Claude + Tavily logic)
├── watcher.py          # Folder watcher + process_images() entry point
├── state.py            # NoteState TypedDict
├── queue_store.py      # In-memory + persistent queue (queue.json)
├── config.py           # Settings dataclass, load/save config.json
├── static/
│   ├── index.html      # Main app shell
│   ├── upload.html     # Mobile upload page (phone)
│   ├── settings.html   # Settings page
│   ├── css/style.css   # Design system (Claude palette, Plus Jakarta Sans)
│   └── js/
│       ├── queue.js    # Grid/tree view, upload modal, polling
│       ├── review.js   # Note review & edit page
│       ├── graph.js    # Force-directed graph (notes + wikilinks)
│       ├── settings.js # Settings page JS
│       └── utils.js    # Theme toggle, shared helpers
├── config.json         # Runtime settings (vault path, expansion level, port)
├── courses.json        # Course definitions
├── requirements.txt
└── .env.example
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `obsidian_vault_path` | `./vault` | Where approved notes are saved |
| `watched_folder` | `./screenshots` | Folder watched for auto-ingestion |
| `default_expansion_level` | `detailed` | `brief` / `detailed` / `deep dive` |
| `port` | `8765` | Local server port |

Settings are changed live via the web UI — no restart needed.

---

## Expansion levels

| Level | Word count | Best for |
|---|---|---|
| Brief | 200–400 | Quick reference cards |
| Detailed | 500–800 | Standard lecture notes |
| Deep Dive | 800+ | Complex topics, research |

---

## Requirements

- Python 3.11+
- macOS / Linux (Windows untested)
- Anthropic API key (Claude Sonnet 4.5 + Claude Haiku)
- Tavily API key (free tier: 1,000 searches/month)
