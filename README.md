# FlashNote

> AI-powered note-taking that turns your photos and screenshots into structured, Obsidian-ready markdown notes — with a human-in-the-loop review UI.

![FlashNote UI](https://img.shields.io/badge/status-active-brightgreen) ![Python](https://img.shields.io/badge/python-3.11+-blue) ![Claude](https://img.shields.io/badge/AI-Claude%20Sonnet-orange) ![Tavily](https://img.shields.io/badge/search-Tavily-purple)

---

## What it does

1. **Capture** — Upload photos from your phone (QR code scan) or drag-and-drop files from your desktop
2. **Process** — A 5-node LangGraph pipeline extracts content, fills knowledge gaps via Tavily search, writes a structured markdown note with mermaid diagrams, and self-reviews quality
3. **Review** — A web UI lets you read, edit, and approve each note before it touches Obsidian
4. **Sync** — Approved notes land in your Obsidian vault under `Course/Module/note.md` with assets

---

## Features

- **Phone upload via QR code** — scan once, shoot up to 15 photos per session
- **Desktop upload modal** — drag-and-drop images or `.txt` notes
- **Group photos per note** — choose 1 / 2 / 3 photos per note to cover multi-page topics
- **Your understanding field** — add your own notes at upload time; AI builds on them
- **AI quality loop** — draft is scored on Accuracy, Completeness, Wikilink Density; regenerates with Claude Sonnet if score is low
- **Graph view** — Obsidian-style force-directed graph showing notes AND wikilinks as nodes, filterable by course/module
- **File tree view** — notes organised as Course → Module → note rows (collapsible)
- **Dark mode** — Claude/Anthropic colour palette with smooth transitions
- **Obsidian sync** — proper YAML frontmatter, `[[wikilinks]]`, mermaid diagrams, assets embedded

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
