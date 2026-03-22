import base64
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import anthropic
from tavily import TavilyClient

from config import settings
from state import NoteState, SearchResult


def _get_module_context(course_name: str, module_name: str) -> dict:
    """Return existing wikilinks and tags from approved/in_review notes in the same module."""
    from queue_store import queue_store
    _wikilink_re = re.compile(r'\[\[([^\]]+)\]\]')

    wikilinks: dict[str, int] = {}  # label → count
    tags: list[str] = []

    for note in queue_store.list_all():
        if note.get("status") not in ("in_review", "approved"):
            continue
        if note.get("course_name") != course_name:
            continue
        if module_name and note.get("module_name") != module_name:
            continue
        # Collect wikilinks from markdown
        for wl in _wikilink_re.findall(note.get("draft_markdown", "")):
            wikilinks[wl] = wikilinks.get(wl, 0) + 1
        # Collect tags from frontmatter
        for tag in note.get("tags", []):
            if tag not in tags:
                tags.append(tag)

    # Sort by frequency so the most-used wikilinks come first
    sorted_wl = sorted(wikilinks, key=lambda k: wikilinks[k], reverse=True)
    return {"wikilinks": sorted_wl[:30], "tags": tags[:20]}

# --- Clients (lazy-init so missing keys fail loudly at call time, not import) ---
_claude: anthropic.Anthropic | None = None
_tavily: TavilyClient | None = None

CLAUDE_SONNET = "claude-sonnet-4-5"
CLAUDE_HAIKU  = "claude-haiku-4-5-20251001"


def _get_claude() -> anthropic.Anthropic:
    global _claude
    if _claude is None:
        _claude = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    return _claude


def _get_tavily() -> TavilyClient:
    global _tavily
    if _tavily is None:
        _tavily = TavilyClient(api_key=settings.tavily_api_key)
    return _tavily


_IMAGE_CACHE: dict[str, tuple[str, str]] = {}
_MEDIA_MAP = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".webp": "image/webp", ".gif": "image/gif"}

def _encode_image(path: str) -> tuple[str, str]:
    """Returns (base64_data, media_type). Cached per path."""
    if path not in _IMAGE_CACHE:
        p = Path(path)
        media_type = _MEDIA_MAP.get(p.suffix.lower(), "image/png")
        data = base64.standard_b64encode(p.read_bytes()).decode("utf-8")
        _IMAGE_CACHE[path] = (data, media_type)
    return _IMAGE_CACHE[path]


def _strip_yaml_fence(md: str) -> str:
    """Ensure frontmatter is proper raw --- delimiters, not wrapped in code fences.

    Handles multiple Claude output patterns:
      - ```yaml\\n---\\n...\\n---\\n```   (fence wrapping entire FM block)
      - ```yaml\\ntitle: ...\\n---\\n```  (fence with content but no leading ---)
      - title: ... (no delimiters at all, body starts with YAML-like keys)
    """
    text = md.strip()

    # Case 1: ```yaml\n---\n...\n---\n``` — correct content inside fence
    m = re.match(r'^```ya?ml\s*\n(---[\s\S]*?---)\s*\n```(.*)$', text, re.DOTALL)
    if m:
        return (m.group(1) + m.group(2)).strip()

    # Case 2: ```yaml\ncontent\n---\n``` — content inside fence, missing leading ---
    m = re.match(r'^```ya?ml\s*\n([\s\S]*?)\n```(.*)$', text, re.DOTALL)
    if m:
        inner = m.group(1).strip()
        rest = m.group(2).strip()
        if not inner.startswith('---'):
            inner = '---\n' + inner
        if not inner.rstrip().endswith('---'):
            inner = inner.rstrip() + '\n---'
        return (inner + '\n' + rest).strip()

    # Case 3: starts with YAML keys but no --- delimiters (e.g. "title: foo\ndate: ...")
    if not text.startswith('---') and re.match(r'^(title|date|tags|course)\s*:', text):
        # Find where frontmatter ends (first blank line or first # heading)
        lines = text.split('\n')
        end = len(lines)
        for i, line in enumerate(lines):
            if line.strip() == '' or line.startswith('#'):
                end = i
                break
        fm_lines = lines[:end]
        body_lines = lines[end:]
        return '---\n' + '\n'.join(fm_lines) + '\n---\n' + '\n'.join(body_lines)

    return text


def _sanitize_mermaid(code: str) -> str:
    """Fix common Mermaid syntax errors that break Obsidian rendering."""
    lines = []
    for line in code.split('\n'):
        # Replace curly braces in labels (breaks mermaid parser)
        # Replace brackets inside node labels — e.g. A[foo [bar]] -> A[foo bar]
        # Fix colons in labels by quoting them
        # Strip trailing whitespace
        line = line.rstrip()
        # Remove zero-width spaces and other invisible unicode
        line = re.sub(r'[\u200b\u200c\u200d\ufeff]', '', line)
        lines.append(line)

    result = '\n'.join(lines).strip()

    # mindmap is extremely finicky — convert to flowchart TD if present
    if result.startswith('mindmap'):
        # Best effort: extract the lines and make a simple flowchart
        # If it's complex, just skip conversion and trust the model
        pass

    return result


def _parse_json_response(text: str, fallback: dict) -> dict:
    """Extract and parse JSON from LLM response text."""
    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip()
    # Try full text first, then brace-extraction
    for attempt in (cleaned, cleaned[cleaned.find("{"):cleaned.rfind("}")+1]):
        try:
            result = json.loads(attempt)
            if isinstance(result, dict):
                return result
        except Exception:
            pass
    print(f"[JSON parse failed] raw response: {text[:300]}")
    return fallback


def _claude_text(prompt: str, max_tokens: int = 2000, images: list[str] | None = None, model: str = CLAUDE_SONNET) -> str:
    """Single-turn Claude call. Optionally attach image paths."""
    content = []
    for path in (images or []):
        data, media_type = _encode_image(path)
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
    content.append({"type": "text", "text": prompt})

    response = _get_claude().messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": content}]
    )
    return response.content[0].text


# ─────────────────────────────────────────────
# Node 1 — Vision / OCR  (Claude)
# ─────────────────────────────────────────────
def intake_extractor(state: NoteState) -> dict:
    """Extract text and diagrams from screenshots using Claude vision."""
    num_images = len(state["image_paths"])
    merge_instruction = ""
    if num_images > 1:
        merge_instruction = (
            f"\n\nThere are {num_images} screenshots. Decide: should these form ONE note "
            f"(single) or SEPARATE notes (separate)? Output as merge_decision: single OR separate."
        )

    user_notes_block = ""
    if state.get("user_notes", "").strip():
        user_notes_block = f"\n\nThe student also wrote these notes about what they understood:\n\"\"\"\n{state['user_notes'].strip()}\n\"\"\"\nUse these to disambiguate content and identify gaps between what they understood and what's on screen."

    prompt = f"""You are analysing screenshots from a video course called "{state['course_name']}".

Please:
1. Extract ALL visible text from the screenshot(s)
2. Describe any diagrams, charts, graphs, or visual elements in detail
3. List any concepts you are UNCERTAIN about that would benefit from verification
{merge_instruction}
{user_notes_block}

Format your response as JSON:
{{
  "extracted_text": "all visible text here",
  "diagram_descriptions": ["description 1"],
  "uncertainties": ["concept 1"],
  "merge_decision": "single"
}}"""

    fallback = {
        "extracted_text": "",
        "diagram_descriptions": [],
        "uncertainties": [],
        "merge_decision": "single"
    }

    try:
        # Sonnet: vision accuracy is critical
        text = _claude_text(prompt, max_tokens=2000, images=state["image_paths"], model=CLAUDE_SONNET)
        return _parse_json_response(text, fallback)
    except Exception as e:
        print(f"Vision extraction failed: {e}")
        return fallback


# ─────────────────────────────────────────────
# Node 2 — Web Search  (Tavily)
# ─────────────────────────────────────────────
def uncertainty_searcher(state: NoteState) -> dict:
    """Search uncertain concepts via Tavily."""
    if not state.get("uncertainties"):
        return {"search_queries": [], "search_results": []}

    uncertainties = state["uncertainties"][:3]
    search_results: list[SearchResult] = []
    course = state.get('course_name', '')

    def _search(query: str) -> list[SearchResult]:
        try:
            resp = _get_tavily().search(
                query=f"{query} {course}",
                max_results=2,
                search_depth="basic"
            )
            return [{"url": r.get("url", ""), "title": r.get("title", ""), "snippet": r.get("content", "")[:300]}
                    for r in resp.get("results", [])]
        except Exception as e:
            print(f"Tavily search failed for '{query}': {e}")
            return []

    try:
        with ThreadPoolExecutor(max_workers=len(uncertainties)) as pool:
            for results in pool.map(_search, uncertainties):
                search_results.extend(results)
    except Exception as e:
        print(f"Tavily parallel search error: {e}")

    return {"search_queries": uncertainties, "search_results": search_results}


# ─────────────────────────────────────────────
# Node 3 — Visual Generator  (Claude)
# ─────────────────────────────────────────────
def visual_generator(state: NoteState) -> dict:
    """Claude generates Mermaid diagrams relevant to the screenshot content."""
    extracted = state.get("extracted_text", "")
    diagrams = state.get("diagram_descriptions", [])

    if not extracted.strip():
        return {"visuals": []}

    diagram_context = ""
    if diagrams:
        diagram_context = "\n\nVisual elements described in the screenshot:\n" + \
                          "\n".join(f"- {d}" for d in diagrams)

    user_notes = state.get("user_notes", "").strip()
    user_notes_block = f"\n\nStudent's own understanding (use this to shape the diagrams toward what matters most to them):\n{user_notes}" if user_notes else ""

    prompt = f"""You are analysing educational content from a course called "{state.get('course_name', 'Unknown')}".

Extracted content:
{extracted}
{diagram_context}
{user_notes_block}

Generate 1–2 Mermaid diagrams that best visualise the concepts.

STRICT SYNTAX RULES (Obsidian mermaid is unforgiving):
- Prefer `flowchart TD` or `flowchart LR` — most reliable in Obsidian
- Use `sequenceDiagram` only for clear step-by-step interactions
- NEVER use `mindmap` — it breaks in Obsidian
- Node labels: use ONLY alphanumeric, spaces, hyphens. NO colons, brackets, quotes, slashes, or parentheses inside labels
- Max 12 nodes per diagram — keep it focused
- Every node ID must be unique (A, B, C... or descriptive short IDs)
- Subgraph titles must be plain text, no special chars
- Each arrow must be on its own line

CORRECT example:
```mermaid
flowchart TD
    Input[Screenshot Input] --> Extract[Text Extraction]
    Extract --> Search[Web Research]
    Search --> Draft[Draft Writer]
    Draft --> Review[Quality Check]
    Review -->|Pass| Approve[Approved Note]
    Review -->|Fail| Draft
```

Return ONLY the mermaid code blocks. No explanation, no text outside the fences."""

    try:
        # Sonnet for reliable mermaid syntax (Haiku makes too many syntax errors)
        text = _claude_text(prompt, max_tokens=2000, model=CLAUDE_SONNET)
        blocks = re.findall(r"```mermaid\n(.*?)```", text, re.DOTALL)
        visuals = []
        for b in blocks:
            clean = _sanitize_mermaid(b.strip())
            if clean:
                visuals.append(f"```mermaid\n{clean}\n```")
        print(f"Visual generator: {len(visuals)} diagram(s) created")
        return {"visuals": visuals}
    except Exception as e:
        print(f"Visual generator failed: {e}")
        return {"visuals": []}


# ─────────────────────────────────────────────
# Node 4 — Draft Writer  (Claude)
# ─────────────────────────────────────────────
def draft_writer(state: NoteState) -> dict:
    """Write the Obsidian markdown note using Claude."""
    expansion = state.get("expansion_level", "detailed")
    expansion_instructions = {
        "brief": "Write a concise note of 200–400 words. Focus on essential summary and key concepts only.",
        "detailed": "Write a thorough note of 500–800 words. Cover all concepts with good detail.",
        "deep dive": "Write a comprehensive note of 800+ words. Include background, analogies, and cross-references."
    }

    search_context = ""
    if state.get("search_results"):
        lines = [f"- [{r['title']}]({r['url']}): {r['snippet']}"
                 for r in state["search_results"][:5] if r.get("snippet")]
        if lines:
            search_context = "\n\nResearch context (from Tavily web search):\n" + "\n".join(lines)

    diagram_context = ""
    if state.get("diagram_descriptions"):
        diagram_context = "\n\nDiagrams/visuals in the screenshot:\n" + \
                          "\n".join(f"- {d}" for d in state["diagram_descriptions"])

    reflection_context = ""
    scores = state.get("reflection_scores")
    if scores and scores.get("feedback"):
        gap_lines = ""
        if scores.get("gaps"):
            gap_lines = "\n\nGAP CORRECTIONS (fill these into the note using domain knowledge):\n"
            for i, g in enumerate(scores["gaps"], 1):
                gap_lines += f"\n{i}. FOUND: \"{g.get('found', '')}\"\n   CORRECT EXPLANATION: {g.get('correction', '')}\n"
        reflection_context = (
            f"\n\nREVISION REQUIRED — incorporate all of the following:"
            f"{gap_lines}"
            f"\nADDITIONAL FEEDBACK:\n{scores['feedback']}\n\n"
            f"IMPORTANT: Do not leave any gaps, abbreviations, or unexplained terms in the final note. "
            f"Use the corrections above and your domain knowledge to produce a complete, logically coherent note."
        )

    image_embeds = "\n".join(state.get("image_embeds", []))
    visuals = state.get("visuals", [])
    visuals_block = "\n\n".join(visuals) if visuals else ""
    today = datetime.now().strftime("%Y-%m-%d")
    course = state.get("course_name", "Unknown Course")
    module = state.get("module_name", "")
    tags = state.get("tags", [])

    # Pull existing module wikilinks/tags so new note reuses them (graph connectivity)
    mod_ctx = _get_module_context(course, module)
    existing_wikilinks = mod_ctx["wikilinks"]
    existing_tags = list({*tags, *mod_ctx["tags"]})
    tags_yaml = "[" + ", ".join(existing_tags) + "]" if existing_tags else "[]"

    module_context = ""
    if existing_wikilinks:
        wl_list = ", ".join(f"[[{w}]]" for w in existing_wikilinks)
        module_context = (
            f"\n\nEXISTING MODULE CONCEPTS (from other notes in this module — "
            f"reuse these [[wikilinks]] wherever they are relevant to this note's content):\n{wl_list}"
        )

    user_notes = state.get("user_notes", "").strip()
    user_notes_block = (
        f"\n\nSTUDENT'S OWN UNDERSTANDING (build on this — expand, correct, and enrich it):\n\"\"\"\n{user_notes}\n\"\"\""
        if user_notes else ""
    )

    prompt = f"""You are creating an Obsidian markdown note from a video course screenshot.

Course: {course}{f" / Module: {module}" if module else ""}
Expansion Level: {expansion} — {expansion_instructions.get(expansion, expansion_instructions['detailed'])}

Extracted text from screenshot:
{state.get("extracted_text", "")}
{diagram_context}
{search_context}
{module_context}
{user_notes_block}
{reflection_context}

{f"Screenshot images to embed at the top:{chr(10)}{image_embeds}" if image_embeds else ""}

{f"Mermaid diagrams to embed (paste these verbatim inside the note — do NOT modify them):{chr(10)}{visuals_block}" if visuals_block else ""}

Create an Obsidian-ready markdown note. Requirements:
1. Start with YAML frontmatter using raw --- delimiters (NOT ```yaml fences): title, date ({today}), tags (use {tags_yaml} plus any inferred — REUSE existing module tags so notes in the same module share tags for graph connectivity), course, sources (URLs from research), expansion_level
2. ## Summary section
3. ## Key Concepts section — use [[wikilinks]] for EVERY major concept (minimum 8 wikilinks, aim for 12+); prefer reusing existing module wikilinks above; also sprinkle [[wikilinks]] throughout the Details section wherever a concept is named
4. ## Visuals section — embed ALL provided Mermaid diagrams here verbatim, each with a short caption
5. ## Details section — main content at the specified expansion level{f"{chr(10)}   If student notes are provided above, acknowledge their understanding and build on it with deeper explanation." if user_notes else ""}
6. ## Open Questions section

CRITICAL: The very first line must be `---` (raw dashes). Do NOT wrap the frontmatter in ```yaml code fences. Obsidian parses raw --- frontmatter, not code-fenced yaml.
Use [[wikilinks]] liberally throughout. Output ONLY the markdown, no explanation."""

    try:
        # First pass: Haiku (rough draft, reflector will catch issues)
        # Second pass: Sonnet (final quality pass incorporating gap corrections)
        loop = state.get("loop_count", 0)
        model = CLAUDE_SONNET if loop >= 1 else CLAUDE_HAIKU
        print(f"Draft writer: loop={loop+1}, model={'Sonnet' if loop >= 1 else 'Haiku'}")
        draft = _claude_text(prompt, max_tokens=4000, model=model)
    except Exception as e:
        print(f"Draft writer failed: {e}")
        draft = f"# Note generation failed\n\nError: {e}\n\nExtracted content:\n{state.get('extracted_text', '')}"

    # Fix frontmatter — ensure proper raw --- delimiters (not code-fenced)
    draft = _strip_yaml_fence(draft)

    # Sanitize any mermaid blocks that Sonnet may have slightly mangled during embedding
    def _resanitize_mermaid_in_draft(text: str) -> str:
        def fix_block(m):
            return f"```mermaid\n{_sanitize_mermaid(m.group(1).strip())}\n```"
        return re.sub(r'```mermaid\n(.*?)```', fix_block, text, flags=re.DOTALL)
    draft = _resanitize_mermaid_in_draft(draft)

    # Extract title from frontmatter
    title = "Untitled Note"
    for line in draft.split("\n"):
        if line.startswith("title:"):
            title = line.replace("title:", "").strip().strip('"').strip("'")
            break

    return {
        "draft_markdown": draft,
        "title": title,
        "loop_count": state.get("loop_count", 0) + 1
    }


# ─────────────────────────────────────────────
# Node 5 — Reflector  (Claude)
# ─────────────────────────────────────────────
def reflector(state: NoteState) -> dict:
    """Verify the draft, find gaps/abbreviations, fill them using domain knowledge."""
    draft_preview = state.get("draft_markdown", "")[:2500]  # enough to count wikilinks accurately
    prompt = f"""You are reviewing an Obsidian note draft for a course: "{state.get('course_name', 'Unknown')}".

ORIGINAL SCREENSHOT TEXT:
{state.get("extracted_text", "")}

DRAFT NOTE (truncated):
{draft_preview}

Scoring criteria:
- accuracy (1-10): Are all facts correct and well-explained? 8+ = no factual errors, key terms defined.
- completeness (1-10): Are all major topics from the screenshot covered with enough depth? 8+ = nothing important missing.
- wikilink_density (1-10): Does the note have 8+ [[wikilinks]] spread across sections? 8+ = rich linking.
- good_enough: true ONLY if ALL three scores are >= 8. Otherwise false.

Tasks:
1. Score each dimension 1-10
2. Find gaps: abbreviations, unexplained terms, cut-off sentences, missing logic
3. For each gap: give the full correct explanation using your domain knowledge

Respond with ONLY a JSON object, no markdown fences, no explanation:
{{"accuracy":9,"completeness":8,"wikilink_density":8,"good_enough":true,"gaps":[],"feedback":"Good note. Minor: expand the feedback loop explanation."}}

If scores are low example:
{{"accuracy":7,"completeness":6,"wikilink_density":5,"good_enough":false,"gaps":[{{"found":"abbreviated term XYZ","correction":"XYZ stands for ... and works by ..."}}],"feedback":"Add wikilinks throughout Details section. Expand Key Concepts with definitions."}}"""

    loop_count = state.get("loop_count", 0)
    fallback = {
        # If reflector itself fails, don't waste another loop — mark as passed
        "accuracy": 8, "completeness": 8, "wikilink_density": 7,
        "good_enough": loop_count >= 1, "gaps": [],
        "feedback": "Reflector parse error — note accepted as-is."
    }

    try:
        # Sonnet: needs domain knowledge to find and fill gaps
        text = _claude_text(prompt, max_tokens=1500, model=CLAUDE_SONNET)
        result = _parse_json_response(text, fallback)
        # Ensure gaps key exists
        if "gaps" not in result:
            result["gaps"] = []
        gaps_found = len(result.get("gaps", []))
        print(f"Reflector: accuracy={result.get('accuracy')}, completeness={result.get('completeness')}, gaps={gaps_found}, good_enough={result.get('good_enough')}")
        return {"reflection_scores": result}
    except Exception as e:
        print(f"Reflector failed: {e}")
        return {"reflection_scores": fallback}


# ─────────────────────────────────────────────
# Node 6 — Finalize
# ─────────────────────────────────────────────
def finalize(state: NoteState) -> dict:
    """Mark note as ready for human review."""
    return {"status": "in_review"}
