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
│                     localhost:8765                              │
│                                                                 │
│  POST /api/upload   →  save files, group by group_size          │
│  GET  /api/queue    →  list notes with status + wikilinks       │
│  PUT  /api/approve  →  write to Obsidian vault                  │
│  PUT  /api/settings →  save config.json live                    │
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

### 3. `visual_generator` — Claude Haiku
- Designs mermaid diagram ideas suited to the content type
  - Flowcharts for processes, sequence diagrams for protocols, mind maps for concepts
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

## Key Design Decisions

**Why LangGraph?** State machine makes the retry loop (Haiku → Sonnet on low scores) explicit and debuggable. Each node is a pure function.

**Why Haiku first?** Haiku is ~10x cheaper and fast enough for a first draft. Sonnet only kicks in when the reflector deems the draft insufficient — typically 1 in 3 notes.

**Why group_size?** A single lecture photo might miss context visible on the next slide. Grouping 2–3 consecutive photos lets Claude see continuity without manually stitching notes.

**Why wikilinks?** Obsidian's graph becomes useful only when notes are densely linked. Scoring wikilink density during reflection incentivises the model to produce notes that actually connect to the knowledge graph.
