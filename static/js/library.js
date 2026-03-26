/* ── FlashNote Library ── */

let allNotes = [];      // full list from /api/library
let currentNoteId = null;
let searchQuery = '';

// Course color palette — matches graph.js COURSE_PALETTE
const COURSE_COLORS = ['#d97757','#c4673f','#a85432','#e8956d','#8b6f5e','#6b4f40','#b8816a','#d4a898'];
const _courseColorCache = {};
function getCourseColor(course) {
  if (!_courseColorCache[course]) {
    const keys = [...new Set(allNotes.map(n => n.course_name).filter(Boolean))].sort();
    const idx = keys.indexOf(course);
    _courseColorCache[course] = COURSE_COLORS[Math.max(idx, 0) % COURSE_COLORS.length];
  }
  return _courseColorCache[course];
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default', securityLevel: 'loose' });

  const hash = location.hash.slice(1);
  await loadLibrary();

  // Restore: URL hash > last visited (localStorage) > nothing
  const last = hash || localStorage.getItem('lib_last_note');
  if (last && allNotes.find(n => n.note_id === last)) openNote(last);

  // ← → keyboard navigation
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateRelative(1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateRelative(-1); }
  });
});

// ── Load sidebar data ─────────────────────────────────────────────────────────
async function loadLibrary() {
  const res = await fetch('/api/library');
  if (!res.ok) return;
  allNotes = await res.json();
  renderTree(allNotes);
  renderRecentGrid();
}

// ── Sidebar tree ─────────────────────────────────────────────────────────────
function renderTree(notes) {
  const q = searchQuery.toLowerCase();
  const filtered = q
    ? notes.filter(n => (n.title || '').toLowerCase().includes(q) ||
                        (n.course_name || '').toLowerCase().includes(q) ||
                        (n.module_name || '').toLowerCase().includes(q) ||
                        (n.tags || []).some(t => t.toLowerCase().includes(q)))
    : notes;

  // Group: course → module → notes
  const tree = {};
  for (const n of filtered) {
    const c = n.course_name || 'Uncategorised';
    const m = n.module_name || '';
    if (!tree[c]) tree[c] = {};
    if (!tree[c][m]) tree[c][m] = [];
    tree[c][m].push(n);
  }

  const container = document.getElementById('lib-tree');
  container.innerHTML = '';

  if (!filtered.length) {
    container.innerHTML = '<p style="padding:16px;font-size:12px;color:var(--muted);">No notes found.</p>';
    return;
  }

  for (const [course, modules] of Object.entries(tree)) {
    const courseEl = document.createElement('div');
    courseEl.className = 'lib-course';

    const courseHeader = document.createElement('button');
    courseHeader.className = 'lib-course-header';
    const totalCount = Object.values(modules).reduce((s, arr) => s + arr.length, 0);
    const dotColor = getCourseColor(course);
    courseHeader.innerHTML = `<span class="lib-chevron">▾</span><span class="lib-course-dot" style="background:${dotColor};"></span><span class="lib-course-name">${escHtml(course)}</span><span class="lib-count">${totalCount}</span>`;
    courseHeader.onclick = () => courseEl.classList.toggle('collapsed');
    courseEl.appendChild(courseHeader);

    const courseBody = document.createElement('div');
    courseBody.className = 'lib-course-body';

    for (const [mod, noteList] of Object.entries(modules)) {
      if (mod) {
        const modEl = document.createElement('div');
        modEl.className = 'lib-module';

        const modHeader = document.createElement('button');
        modHeader.className = 'lib-module-header';
        modHeader.innerHTML = `<span class="lib-chevron">▾</span><span class="lib-mod-name">${escHtml(mod)}</span><span class="lib-count">${noteList.length}</span>`;
        modHeader.onclick = () => modEl.classList.toggle('collapsed');
        modEl.appendChild(modHeader);

        const modBody = document.createElement('div');
        modBody.className = 'lib-module-body';
        for (const n of noteList) modBody.appendChild(noteItem(n));
        modEl.appendChild(modBody);
        courseBody.appendChild(modEl);
      } else {
        for (const n of noteList) courseBody.appendChild(noteItem(n));
      }
    }

    courseEl.appendChild(courseBody);
    container.appendChild(courseEl);
  }
}

function noteItem(n) {
  const el = document.createElement('button');
  el.className = 'lib-note-item';
  el.dataset.noteId = n.note_id;
  if (n.note_id === currentNoteId) el.classList.add('active');
  el.textContent = n.title || 'Untitled';
  el.onclick = () => openNote(n.note_id);
  return el;
}

// ── Recent notes grid (empty state) ──────────────────────────────────────────
function renderRecentGrid() {
  const grid = document.getElementById('lib-recent-grid');
  if (!grid) return;
  // Show last 9 notes sorted by timestamp desc
  const recent = [...allNotes].sort((a, b) => (b.timestamp || 0) > (a.timestamp || 0) ? 1 : -1).slice(0, 9);
  grid.innerHTML = recent.map(n => {
    const color = getCourseColor(n.course_name || '');
    const date = n.timestamp ? new Date(n.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return `<button class="lib-recent-card" onclick="openNote('${escHtml(n.note_id)}')">
      <div class="lib-recent-card-course">
        <span class="lib-recent-card-dot" style="background:${color};"></span>
        ${escHtml(n.course_name || 'Uncategorised')}
      </div>
      <div class="lib-recent-card-title">${escHtml(n.title || 'Untitled')}</div>
      ${date ? `<div class="lib-recent-card-meta">${escHtml(n.module_name || '')}${n.module_name && date ? ' · ' : ''}${date}</div>` : ''}
    </button>`;
  }).join('');
}

// ── Open a note ───────────────────────────────────────────────────────────────
async function openNote(noteId) {
  currentNoteId = noteId;

  // Update active state in tree
  document.querySelectorAll('.lib-note-item').forEach(el => {
    el.classList.toggle('active', el.dataset.noteId === noteId);
  });

  let res;
  try { res = await fetch(`/api/library/${noteId}`); }
  catch (err) { showToast('Network error loading note', 'error'); return; }
  if (!res.ok) { showToast('Note not found', 'error'); return; }
  const note = await res.json();

  // Persist last-visited note
  localStorage.setItem('lib_last_note', noteId);

  // Update URL hash without reload
  history.replaceState(null, '', '#' + noteId);

  document.getElementById('lib-empty').style.display = 'none';
  document.getElementById('lib-reader').style.display = 'block';

  // Scroll main area to top
  document.querySelector('.lib-main')?.scrollTo({ top: 0, behavior: 'instant' });

  // Breadcrumb + position counter
  const parts = [note.course_name, note.module_name].filter(Boolean);
  const idx = allNotes.findIndex(n => n.note_id === noteId);
  const posLabel = idx >= 0 ? `<span class="lib-bc-pos">${idx + 1} / ${allNotes.length}</span>` : '';
  document.getElementById('lib-breadcrumb').innerHTML =
    parts.map(p => `<span>${escHtml(p)}</span>`).join('<span class="lib-bc-sep">›</span>') + posLabel;

  // Title
  document.getElementById('lib-note-title').textContent = note.title || 'Untitled';

  // Meta: tags + date
  const date = note.timestamp ? new Date(note.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const tags = (note.tags || []).map(t => `<span class="lib-tag">${escHtml(t)}</span>`).join('');
  document.getElementById('lib-note-meta').innerHTML = `${tags}${date ? `<span class="lib-date">${date}</span>` : ''}`;

  // Source image links — open in new tab
  const thumbsEl = document.getElementById('lib-thumbs');
  if (note.image_paths && note.image_paths.length) {
    thumbsEl.innerHTML = note.image_paths.map((_, i) =>
      `<a href="/api/image-raw/${noteId}?idx=${i}" target="_blank" class="lib-source-link">📷 Source ${i + 1}</a>`
    ).join('');
    thumbsEl.style.display = 'flex';
  } else {
    thumbsEl.style.display = 'none';
    thumbsEl.innerHTML = '';
  }

  // Edit link + prev/next
  document.getElementById('lib-edit-link').href = `/review/${noteId}`;
  updateNavButtons(noteId);

  // Render markdown
  renderContent(note.draft_markdown || '_No content yet._');
}

// ── Markdown rendering ────────────────────────────────────────────────────────
function renderContent(md) {
  // Strip YAML frontmatter if present
  md = md.replace(/^---[\s\S]*?---\n?/, '');

  // Strip ![[image]] Obsidian embeds FIRST (before wikilink conversion eats the brackets)
  md = md.replace(/!\[\[[^\]]+\]\]\s*/g, '');

  // Convert [[wikilinks]] → clickable spans (show label only, no brackets)
  md = md.replace(/\[\[([^\]]+)\]\]/g, (_, label) =>
    `<span class="lib-wikilink" onclick="navigateWikilink('${escHtml(label).replace(/'/g, "\\'")}'" title="Go to: ${escHtml(label)}">${escHtml(label)}</span>`
  );

  const html = marked.parse(md);
  const container = document.getElementById('lib-content');
  container.innerHTML = html;

  // Render mermaid blocks
  container.querySelectorAll('code.language-mermaid, pre code').forEach(el => {
    const text = el.textContent.trim();
    if (!text.match(/^(graph|flowchart|sequenceDiagram|classDiagram|gantt|pie|stateDiagram|erDiagram|journey|gitGraph)/i)) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'lib-mermaid';
    wrapper.textContent = text;
    el.closest('pre')?.replaceWith(wrapper) ?? el.replaceWith(wrapper);
  });
  mermaid.run({ nodes: container.querySelectorAll('.lib-mermaid') }).catch(err => {
    console.warn('[mermaid] render error:', err);
  });
}

// ── Wikilink navigation ───────────────────────────────────────────────────────
function navigateWikilink(label) {
  const lower = label.toLowerCase();
  // First try exact title match, then partial
  const exact = allNotes.find(n => (n.title || '').toLowerCase() === lower);
  if (exact) { openNote(exact.note_id); return; }
  const partial = allNotes.find(n => (n.title || '').toLowerCase().includes(lower));
  if (partial) { openNote(partial.note_id); return; }
  // Also check tags and wikilinks fields
  const byTag = allNotes.find(n => (n.tags || []).some(t => t.toLowerCase() === lower));
  if (byTag) { openNote(byTag.note_id); return; }
  showToast(`No note found for "[[${label}]]"`, 'info');
}

// ── Prev / Next navigation ────────────────────────────────────────────────────
function navigateRelative(delta) {
  if (!currentNoteId || !allNotes.length) return;
  const idx = allNotes.findIndex(n => n.note_id === currentNoteId);
  if (idx < 0) return;
  const next = allNotes[idx + delta];
  if (next) openNote(next.note_id);
}

function updateNavButtons(noteId) {
  const idx = allNotes.findIndex(n => n.note_id === noteId);
  const prevBtn = document.getElementById('lib-prev-btn');
  const nextBtn = document.getElementById('lib-next-btn');
  if (!prevBtn || !nextBtn) return;
  const prev = allNotes[idx - 1];
  const next = allNotes[idx + 1];
  prevBtn.disabled = !prev;
  prevBtn.title = prev ? `← ${prev.title}` : '';
  nextBtn.disabled = !next;
  nextBtn.title = next ? `→ ${next.title}` : '';
}

// ── Search ────────────────────────────────────────────────────────────────────
function onLibSearch(val) {
  searchQuery = val;
  renderTree(allNotes);
}


function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
