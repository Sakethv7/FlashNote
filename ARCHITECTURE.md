# FlashNote — Architecture & Pipeline

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          User Inputs                            │
│                                                                 │
│  📱 Phone (QR)     💻 Desktop upload     📁 Watched folder      │
│  images + notes    images / .txt          screenshots/          │
└────────────┬──────────────┬──────────────────┬─────────────────┘
             │              │                  │
             └──────────────┴──────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FastAPI  (api.py)                           │
│              dev: localhost:8766 / main: localhost:8765         │
│                                                                 │
│  POST /api/upload             →  save files, group by mode      │
│  POST /api/suggest-placement  →  Claude Haiku reads images,     │
│                                  returns best course + module   │
│  GET  /api/library            →  approved notes for library UI  │
│  GET  /api/queue              →  list notes with status         │
│  PUT  /api/approve            →  write to Obsidian vault        │
│  POST /api/queue/consolidate  →  LLM dedup + merge              │
│  POST /api/queue/smart-order  →  LLM reorder by topic logic     │
│  PUT  /api/settings           →  save config.json live          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                    process_images()
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│               LangGraph Pipeline  (pipeline.py)                 │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   intake_    │    │  uncertainty │    │     visual_      │  │
│  │  extractor   │───▶│   searcher   │───▶│    generator     │  │
│  │              │    │              │    │                  │  │
│  │ Claude Sonnet│    │ Tavily (3x   │    │  Claude Haiku    │  │
│  │ Vision: read │    │ parallel)    │    │  ASCII/mermaid   │  │
│  │ text, diagrams    │ fills gaps   │    │  diagram ideas   │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                   │            │
│  ┌──────────────┐    ┌──────────────┐             │            │
│  │   finalize   │◀───│   reflector  │◀────────────┘            │
│  │              │    │              │    ┌──────────────────┐  │
│  │ status →     │    │ Claude Sonnet│    │   draft_writer   │  │
│  │ in_review    │    │ scores draft │    │                  │  │
│  │              │    │ Accuracy /   │    │ loop=0 → Haiku   │  │
│  └──────────────┘    │ Completeness /    │ loop≥1 → Sonnet  │  │
│                      │ WikilinkDensity   └──────────────────┘  │
│                      │              │                          │
│                      │ score < 7 →  loop again (max 2x)        │
│                      └──────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
                            │
                     status: in_review
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Review UI  (index.html)                      │
│                                                                 │
│  Grid / Tree view ──▶ click note ──▶ review page               │
│                                                                 │
│  • Read AI-generated markdown (rendered preview)               │
│  • Edit inline                                                  │
│  • Check quality scores (Accuracy / Completeness / Wikilinks)  │
│  • Approve → saves to Obsidian vault                            │
│  • Regenerate → re-runs pipeline with Claude Sonnet             │
│  • Reject → removes from queue                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Approve
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Obsidian Vault                               │
│                                                                 │
│  vault/                                                         │
│  └── Course Name/                                               │
│      └── Module Name/                                           │
│          ├── Note Title.md         ← YAML frontmatter +         │
│          │                            markdown + mermaid        │
│          └── assets/                                            │
│              └── photo.jpg         ← copied from uploads/       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Pipeline Nodes

### 1. `intake_extractor` — Claude Sonnet Vision
- Receives: list of image paths (1–3 photos per note)
- Extracts: all visible text, equations, diagrams, tables
- Identifies: 3–5 knowledge gaps / uncertainties to search for
- Output: `extracted_content`, `uncertainties[]`

### 2. `uncertainty_searcher` — Tavily
- Runs up to 3 Tavily searches **in parallel** (`ThreadPoolExecutor`)
- Each search targets one uncertainty from step 1
- Output: `search_results[]`, `search_queries[]`

### 3. `visual_generator` — Claude Sonnet
- Generates 1–2 Mermaid diagrams suited to the content
  - Prefers `flowchart TD` / `flowchart LR` — most reliable in Obsidian
  - NEVER uses `mindmap` (known Obsidian rendering failure)
  - Node labels: alphanumeric + spaces only; no colons, brackets, or special chars
  - Max 12 nodes per diagram
- Post-processes diagrams through `_sanitize_mermaid()` to strip invisible Unicode and fix common issues
- Output: `visuals[]` (mermaid code blocks)

### 4. `draft_writer` — Claude Haiku (1st pass) / Sonnet (retry)
- Writes full Obsidian markdown note with:
  - YAML frontmatter (title, date, tags, course, module, sources, expansion_level)
  - `## Key Concepts` — bullet points with `[[wikilinks]]`
  - `## Detailed Notes` — structured content from extraction + search
  - `## Visuals` — mermaid diagrams from step 3
  - `## Summary`
- Model routing: `loop_count == 0` → Haiku (fast, cheap first draft)
- Model routing: `loop_count >= 1` → Sonnet (higher quality on retry)
- Output: `draft_markdown`

### 5. `reflector` — Claude Sonnet
- Scores the draft on three dimensions (1–10):
  - **Accuracy** — factual correctness vs source material
  - **Completeness** — coverage of key concepts
  - **Wikilink Density** — richness of `[[concept]]` links for graph connections
- If any score < 7: increments `loop_count`, routes back to `draft_writer`
- Max 2 loops (Haiku → Sonnet → finalize)
- Output: `reflection_scores{}`, `loop_count`

### 6. `finalize`
- Sets `status: in_review`
- Note appears in the Review UI queue

---

## Model Routing

| Phase | Model | Reason |
|---|---|---|
| Intake extraction | Claude Sonnet 4.5 | Vision + complex reasoning needed |
| Draft (1st pass) | Claude Haiku 4.5 | Fast & cheap for initial draft |
| Draft (retry) | Claude Sonnet 4.5 | Higher quality when Haiku draft scores low |
| Reflection / scoring | Claude Sonnet 4.5 | Nuanced self-evaluation |
| Visual generation | Claude Haiku 4.5 | Simple structured output task |

---

## Data Flow

```
NoteState (TypedDict)
├── note_id          UUID
├── image_paths[]    local file paths (1–3 photos)
├── course_name      from upload form
├── module_name      from upload form
├── user_notes       user's own understanding (optional)
├── expansion_level  brief / detailed / deep dive
├── tags[]           from course config
├── extracted_content  raw text from vision
├── uncertainties[]  gaps to search
├── search_queries[] what was searched
├── search_results[] Tavily snippets
├── visuals[]        mermaid diagrams
├── draft_markdown   the note content
├── reflection_scores  {accuracy, completeness, wikilink_density, feedback}
├── loop_count       0 → 1 → 2 (controls model routing)
├── status           processing → in_review → approved / rejected
├── title            extracted note title
├── thumbnail_path   first image (shown in grid)
└── timestamp        ISO datetime
```

---

## File Upload Flow

```
Mobile (QR)                    Desktop modal
    │                               │
    │  POST /api/upload             │  POST /api/upload
    │  files[]: File[]              │  files[]: File[]
    │  course_name: str             │  course_name: str
    │  module_name: str             │  module_name: str
    │  group_size: 1|2|3            │  group_size: 1|2|3
    │  user_notes: str              │  user_notes: str
    └───────────────────────────────┘
                    │
                    ▼
        Save images to uploads/
                    │
        Group by group_size:
        [img1, img2, img3, img4, img5, img6]
        group_size=2 → [[img1,img2], [img3,img4], [img5,img6]]
                    │
        For each group: process_images(group, course, module)
                    │
        Background thread → LangGraph pipeline
                    │
        queue_store.add(initial_state)
                    │
        Returns note_ids[]
```

---

## Graph View

The graph visualises **two node types**:

| Node type | Size | Colour | Represents |
|---|---|---|---|
| Note node | Large (r=18) | Coral (accent) | An approved note |
| Wikilink node | Small (r=7–14) | Muted orange | A `[[concept]]` referenced in notes |

Edges connect notes to the wikilinks they contain. Wikilinks shared across multiple notes become **hubs** — surfacing conceptual overlap between topics. This mirrors Obsidian's graph view.

Filters: All / per-course / per-module — built dynamically from note metadata.

---

## Upload — Auto-detect Placement

When the user adds images to the upload form, a **✦ Auto-detect** button appears. Clicking it:

1. Sends up to 3 images (resized to 512px for cost) to `POST /api/suggest-placement`
2. The endpoint builds a `course → [modules]` map from all approved notes
3. Sends images + structure to Claude Haiku with the prompt: *"which existing course and module do these best fit?"*
4. Returns `{ course, module, reason }` — form fields are auto-filled

Cost: one Claude Haiku call (~500 input tokens + image). Falls back gracefully if no existing notes.

---

## Library View

The library (`/library`) is a **read-only folder explorer**:

- Left sidebar: Course → Module tree, all collapsed by default
- Active course/module (based on current note) auto-expands on load
- Search expands all matching nodes
- Sidebar can be toggled with the ◀/▶ button (state persists via localStorage)
- Main panel: note reader with breadcrumb, prev/next nav, source image lightbox

---

## Queue Post-Processing

Each course/module row in the queue tree exposes 5 actions (visible on hover):

| Button | Function | Cost |
|---|---|---|
| 🔀 Consolidate | Claude reviews all notes for redundancy; merges duplicates, deletes redundant ones | API call |
| 🗂 Smart Order | Claude suggests optimal reading order; updates `sequence` field | API call |
| ✓ Approve all | Bulk approve → writes to Obsidian vault | Free |
| ↻ Regen | Re-runs full pipeline on all notes in scope | API calls |
| 🗑 Delete | Removes notes from queue | Free |

Note: Smart Merge (⊕) was removed — it overlapped with Consolidate. Consolidate is more capable (works on approved notes, can delete pure duplicates).

---

## Key Design Decisions

**Why LangGraph?** State machine makes the retry loop (Haiku → Sonnet on low scores) explicit and debuggable. Each node is a pure function.

**Why Haiku first?** Haiku is ~10x cheaper and fast enough for a first draft. Sonnet only kicks in when the reflector deems the draft insufficient — typically 1 in 3 notes.

**Why group_size?** A single lecture photo might miss context visible on the next slide. Grouping 2–3 consecutive photos lets Claude see continuity without manually stitching notes.

**Why wikilinks?** Obsidian's graph becomes useful only when notes are densely linked. Scoring wikilink density during reflection incentivises the model to produce notes that actually connect to the knowledge graph.

**Do agents communicate during self-review?** Yes. The `reflector` scores the draft and attaches a `feedback` string + `gaps[]` list (each gap has a `found` abbreviation and a `correction` explanation). The `draft_writer` reads these on the retry pass and explicitly incorporates them via a `REVISION REQUIRED` block in its prompt. This is **sequential, within-note communication** — one note at a time, not parallel agents.

**How many agents are there?** 6 nodes in the LangGraph state machine — `intake_extractor`, `uncertainty_searcher`, `visual_generator`, `draft_writer`, `reflector`, `finalize`. They run sequentially on the same `NoteState`. The Tavily step uses a `ThreadPoolExecutor` to fan out 3 searches in parallel, but those are I/O calls, not separate AI agents. Multiple notes process concurrently via Python threads (staggered 20 s apart to stay under the 30k token/min rate limit).

---

## Rate Limiting

Claude Sonnet has a 30,000 input-token/minute limit on the API. Two safeguards:

1. **Per-call backoff** (`_claude_text`): exponential retry on `rate_limit` / `overloaded` errors — waits 15 s, 30 s, 60 s, 120 s, 240 s before giving up.
2. **Bulk stagger**: when regenerating many notes at once, each pipeline starts 20 s after the previous one.

---

## Obsidian Compatibility

Two common failures fixed in the pipeline:

| Issue | Root cause | Fix |
|---|---|---|
| YAML parsed as code block | Claude sometimes wraps frontmatter in ` ```yaml ` fences | `_strip_yaml_fence()` in `nodes.py` strips the fence and ensures raw `---` delimiters |
| Mermaid diagram breaks | Colons / brackets / invisible Unicode in node labels | `_sanitize_mermaid()` cleans each diagram; `_resanitize_mermaid_in_draft()` re-cleans after embedding |
