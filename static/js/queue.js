// ===== Queue Page JavaScript =====

let autoRefreshInterval = null;
let lastQueueData = null; // change-detection cache
let currentView = 'grid';
let showApproved = false; // approved notes hidden by default

// Hover preview state
const previewCache = {};
let hoverTimeout = null;

// ===== Desktop Upload Modal =====
const DESKTOP_MAX = 15;
let desktopQueue = []; // [{file, objectUrl}]
let desktopGroupSize = 1;

const desktopGroupHints = {
  1: 'Each photo → its own note, processed in order.',
  2: 'Every 2 consecutive photos → 1 combined note.',
  3: 'Every 3 consecutive photos → 1 rich chapter note.',
};

function setDesktopGroup(n, btn) {
  desktopGroupSize = n;
  document.querySelectorAll('.desktop-group-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('desktop-group-hint').textContent = desktopGroupHints[n];
  updateDesktopUploadLabel();
}

function updateDesktopUploadLabel() {
  const n = desktopQueue.length;
  if (n === 0) { document.getElementById('desktop-upload-btn').innerHTML = '↑ Upload & Generate'; return; }
  const notes = Math.ceil(n / desktopGroupSize);
  document.getElementById('desktop-upload-btn').innerHTML =
    `↑ Upload & Generate ${notes} Note${notes > 1 ? 's' : ''}`;
}

function openUploadModal() {
  document.getElementById('upload-backdrop').style.display = 'block';
  document.getElementById('upload-modal').style.display = 'block';
  fetch('/api/courses').then(r => r.json()).then(courses => {
    document.getElementById('desktop-course-suggestions').innerHTML =
      courses.map(c => `<option value="${escapeHtml(c.course_name)}"></option>`).join('');
  }).catch(() => {});
}

function closeUploadModal() {
  document.getElementById('upload-backdrop').style.display = 'none';
  document.getElementById('upload-modal').style.display = 'none';
  desktopQueue.forEach(i => URL.revokeObjectURL(i.objectUrl));
  desktopQueue = [];
  desktopGroupSize = 1;
  document.querySelectorAll('.desktop-group-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  const hint = document.getElementById('desktop-group-hint');
  if (hint) hint.textContent = desktopGroupHints[1];
  document.getElementById('desktop-file-input').value = '';
  document.getElementById('desktop-course-input').value = '';
  document.getElementById('desktop-module-input').value = '';
  const un = document.getElementById('desktop-user-notes');
  if (un) un.value = '';
  document.getElementById('desktop-progress').style.display = 'none';
  document.getElementById('desktop-progress-fill').style.width = '0%';
  document.getElementById('desktop-upload-btn').disabled = true;
  renderDesktopThumbs();
}

function addDesktopFiles(fileList) {
  const remaining = DESKTOP_MAX - desktopQueue.length;
  Array.from(fileList).slice(0, remaining).forEach(f => {
    desktopQueue.push({ file: f, objectUrl: /^image\//i.test(f.type) ? URL.createObjectURL(f) : null });
  });
  renderDesktopThumbs();
  checkDesktopReady();
}

function renderDesktopThumbs() {
  const dropZone = document.getElementById('desktop-drop-zone');
  const thumbSection = document.getElementById('desktop-thumb-section');
  const strip = document.getElementById('desktop-thumb-strip');
  const addTile = document.getElementById('desktop-add-tile');
  const countBadge = document.getElementById('desktop-file-count');

  if (desktopQueue.length === 0) {
    dropZone.style.display = '';
    thumbSection.style.display = 'none';
    return;
  }
  dropZone.style.display = 'none';
  thumbSection.style.display = '';

  // Clear old thumbs
  strip.querySelectorAll('.dt-wrap').forEach(el => el.remove());
  countBadge.textContent = `${desktopQueue.length} / ${DESKTOP_MAX}`;

  desktopQueue.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'dt-wrap';
    wrap.style.cssText = 'position:relative;flex-shrink:0;width:68px;height:68px;';
    const inner = item.objectUrl
      ? `<img src="${item.objectUrl}" style="width:68px;height:68px;object-fit:cover;border-radius:8px;border:1.5px solid var(--border);display:block;" />`
      : `<div style="width:68px;height:68px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:22px;">📄</div>`;
    wrap.innerHTML = `${inner}
      <div style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;border:2px solid var(--bg);font-size:10px;line-height:14px;text-align:center;cursor:pointer;font-weight:700;z-index:2;" data-rm="${i}">✕</div>
      <div style="position:absolute;bottom:3px;left:3px;background:rgba(0,0,0,0.5);color:#fff;font-size:9px;font-weight:600;border-radius:3px;padding:1px 4px;">${i+1}</div>`;
    wrap.querySelector('[data-rm]').addEventListener('click', e => {
      e.stopPropagation();
      URL.revokeObjectURL(desktopQueue[i].objectUrl);
      desktopQueue.splice(i, 1);
      renderDesktopThumbs();
      checkDesktopReady();
    });
    strip.insertBefore(wrap, addTile);
  });

  addTile.style.display = desktopQueue.length >= DESKTOP_MAX ? 'none' : '';
  updateDesktopUploadLabel();
}

function checkDesktopReady() {
  const course = document.getElementById('desktop-course-input').value.trim();
  document.getElementById('desktop-upload-btn').disabled = !(desktopQueue.length > 0 && course);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('desktop-file-input').addEventListener('change', e => {
    addDesktopFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('desktop-file-input-more').addEventListener('change', e => {
    addDesktopFiles(e.target.files);
    e.target.value = '';
  });

  const dropZone = document.getElementById('desktop-drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addDesktopFiles(e.dataTransfer.files);
  });
});

async function doDesktopUpload() {
  const course = document.getElementById('desktop-course-input').value.trim();
  const module = document.getElementById('desktop-module-input').value.trim();
  const userNotes = (document.getElementById('desktop-user-notes')?.value || '').trim();
  if (!desktopQueue.length || !course) return;

  const btn = document.getElementById('desktop-upload-btn');
  const progressWrap = document.getElementById('desktop-progress');
  const progressFill = document.getElementById('desktop-progress-fill');
  const progressLabel = document.getElementById('desktop-progress-label');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  const expectedNotes = Math.ceil(desktopQueue.length / desktopGroupSize);
  progressLabel.textContent = `Uploading ${desktopQueue.length} file${desktopQueue.length > 1 ? 's' : ''}…`;
  progressFill.style.width = '15%';

  // Send all files in one request — backend handles grouping
  const form = new FormData();
  desktopQueue.forEach(({ file }) => form.append('files', file));
  form.append('course_name', course);
  form.append('module_name', module);
  form.append('group_size', desktopGroupSize);
  if (userNotes) form.append('user_notes', userNotes);

  let pct = 15;
  const ticker = setInterval(() => {
    pct = Math.min(pct + (88 - pct) * 0.06, 88);
    progressFill.style.width = pct + '%';
  }, 300);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    clearInterval(ticker);
    if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Upload failed'); }
    const data = await res.json();
    const noteCount = data.count || 1;
    progressFill.style.width = '100%';
    await new Promise(r => setTimeout(r, 300));
    showToast(`${noteCount} note${noteCount > 1 ? 's' : ''} queued for processing!`, 'success');
    lastQueueData = null;
    fetchQueue();
    closeUploadModal();
  } catch (err) {
    clearInterval(ticker);
    progressWrap.style.display = 'none';
    btn.disabled = false;
    showToast(`Upload failed: ${err.message}`, 'error');
  }
}

// ===== QR Modal =====
async function openQR() {
  document.getElementById('qr-backdrop').style.display = 'block';
  document.getElementById('qr-modal').style.display = 'block';
  // Refresh QR image in case IP changed
  document.getElementById('qr-img').src = '/api/qr?' + Date.now();
  try {
    const res = await fetch('/api/upload-url');
    const { url } = await res.json();
    const el = document.getElementById('qr-url');
    el.textContent = url;
    el.onclick = () => window.open(url, '_blank');
  } catch {}
}

function closeQR() {
  document.getElementById('qr-backdrop').style.display = 'none';
  document.getElementById('qr-modal').style.display = 'none';
}

function statusLabel(status) {
  const labels = {
    processing: 'Processing',
    in_review: 'In Review',
    approved: 'Approved',
    rejected: 'Rejected'
  };
  return labels[status] || status;
}

function setView(view) {
  currentView = view;

  const cardsContainer = document.getElementById('cards-container');
  const graphContainer = document.getElementById('graph-container');

  // Update toggle button states
  document.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  if (view === 'graph') {
    cardsContainer.style.display = 'none';
    graphContainer.classList.add('active');
    // Fetch notes and build graph
    fetch('/api/queue')
      .then(res => res.ok ? res.json() : [])
      .then(notes => updateGraph(notes))
      .catch(err => console.error('Graph fetch error:', err));
  } else {
    cardsContainer.style.display = '';
    graphContainer.classList.remove('active');
  }
}

async function showPreview(noteId, cardRect) {
  const el = document.getElementById('hover-preview');
  if (!el) return;

  let text = previewCache[noteId];
  if (text === undefined) {
    try {
      const res = await fetch(`/api/queue/${noteId}/preview`);
      if (res.ok) {
        const data = await res.json();
        text = data.preview || '';
      } else {
        text = '';
      }
      previewCache[noteId] = text;
    } catch {
      text = '';
      previewCache[noteId] = text;
    }
  }

  if (!text) return;

  el.textContent = text;

  // Position: below the card, aligned to left edge
  const top = cardRect.bottom + 8 + window.scrollY;
  const left = cardRect.left + window.scrollX;

  // Make sure it doesn't go off screen right edge
  const maxLeft = window.innerWidth - 320;
  el.style.top = top + 'px';
  el.style.left = Math.min(left, maxLeft) + 'px';
  el.classList.add('visible');
}

function hidePreview() {
  clearTimeout(hoverTimeout);
  const el = document.getElementById('hover-preview');
  if (el) el.classList.remove('visible');
}

function renderCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.note_id;
  const isProcessing = note.status === 'processing';
  card.innerHTML = `
    <div class="note-card-thumb">
      ${isProcessing
        ? `<div class="spinner" style="width:20px;height:20px;border-width:2px;"></div>`
        : `<img src="/api/thumbnail/${note.note_id}" alt="" onerror="this.style.display='none'">`
      }
    </div>
    <div class="note-card-body">
      <div class="note-card-title" title="Double-click to rename">${escapeHtml(note.title || 'Untitled')}</div>
      <div class="note-card-meta">
        <span class="badge badge-${note.status}">${statusLabel(note.status)}</span>
        ${note.course_name ? `<span class="badge badge-course">${escapeHtml(note.course_name)}</span>` : ''}
        ${note.loop_count > 0 ? `<span class="loop-chip">⟳ ${note.loop_count}</span>` : ''}
      </div>
      <div class="note-card-timestamp">${formatRelativeTimestamp(note.timestamp)}</div>
    </div>
    <a href="/review/${note.note_id}" class="note-card-arrow" title="Review">→</a>
  `;

  // Double-click title to rename inline
  const titleEl = card.querySelector('.note-card-title');
  titleEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    hidePreview();
    startInlineRename(titleEl, note.note_id);
  });

  // Hover preview
  card.addEventListener('mouseenter', () => {
    hoverTimeout = setTimeout(() => showPreview(note.note_id, card.getBoundingClientRect()), 200);
  });
  card.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimeout);
    hidePreview();
  });

  return card;
}

function renderNoteRow(note) {
  const row = document.createElement('div');
  row.className = 'ft-note-row';
  row.dataset.noteId = note.note_id;

  const statusDot = { approved: '🟢', in_review: '🟡', processing: '🔵', rejected: '🔴' }[note.status] || '⚪';

  const canApprove = note.status === 'in_review';
  row.innerHTML = `
    <span class="ft-note-icon">${statusDot}</span>
    <span class="ft-note-title">${escapeHtml(note.title || 'Untitled')}</span>
    <span class="ft-note-time">${formatRelativeTimestamp(note.timestamp)}</span>
    <a href="/review/${note.note_id}" class="ft-note-open" title="Open">→</a>
    ${canApprove ? `<button class="ft-approve" title="Approve & save to Obsidian" onclick="event.stopPropagation()">✓</button>` : ''}
    <button class="ft-regen" title="Regenerate note" onclick="event.stopPropagation()">↻</button>
    <button class="ft-trash" title="Delete note" onclick="event.stopPropagation()">🗑</button>
  `;

  if (canApprove) {
    row.querySelector('.ft-approve').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.textContent = '…'; btn.disabled = true;
      await fetch(`/api/queue/${note.note_id}/approve`, { method: 'POST',
        headers: {'Content-Type':'application/json'}, body: '{}' });
      lastQueueData = null; fetchQueue();
    });
  }

  row.querySelector('.ft-regen').addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.textContent = '…'; btn.disabled = true;
    await fetch(`/api/queue/${note.note_id}/regenerate`, { method: 'POST',
      headers: {'Content-Type':'application/json'}, body: '{}' });
    lastQueueData = null; fetchQueue();
    btn.textContent = '↻'; btn.disabled = false;
  });

  row.querySelector('.ft-trash').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${note.title || 'Untitled'}"?`)) return;
    await fetch(`/api/queue/${note.note_id}`, { method: 'DELETE' });
    lastQueueData = null;
    fetchQueue();
  });

  // Hover preview
  row.addEventListener('mouseenter', () => {
    hoverTimeout = setTimeout(() => showPreview(note.note_id, row.getBoundingClientRect()), 200);
  });
  row.addEventListener('mouseleave', () => { clearTimeout(hoverTimeout); hidePreview(); });

  // Click row to open review — ignore clicks on any action button/link
  row.addEventListener('click', e => {
    if (e.target.closest('.ft-approve, .ft-regen, .ft-trash, .ft-note-open')) return;
    window.location.href = `/review/${note.note_id}`;
  });

  return row;
}

// Shared bulk action helper — all three bulk operations use this
async function _bulkAction({ endpoint, method = 'POST', confirmMsg, successMsg, btn, course, module }) {
  if (!confirm(confirmMsg)) return;
  const original = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  const params = new URLSearchParams();
  if (course) params.set('course_name', course);
  if (module !== undefined) params.set('module_name', module);
  try {
    const res = await fetch(`${endpoint}?${params}`, { method });
    const data = await res.json();
    showToast(successMsg(data), 'success');
    lastQueueData = null;
    fetchQueue();
  } finally {
    btn.textContent = original; btn.disabled = false;
  }
}

function deleteBulk(course, module, label, btn) {
  _bulkAction({ endpoint: '/api/queue/bulk', method: 'DELETE',
    confirmMsg: `Delete all notes in "${label}"?`,
    successMsg: d => `Deleted ${d.count ?? '?'} note${d.count !== 1 ? 's' : ''}`,
    btn, course, module });
}

function approveBulk(course, module, label, btn) {
  _bulkAction({ endpoint: '/api/queue/bulk/approve', method: 'POST',
    confirmMsg: `Approve & save all in-review notes in "${label}" to Obsidian?`,
    successMsg: d => `Approved ${d.approved} note${d.approved !== 1 ? 's' : ''} → Obsidian`,
    btn, course, module });
}

function regenBulk(course, module, label, btn) {
  _bulkAction({ endpoint: '/api/queue/bulk/regenerate', method: 'POST',
    confirmMsg: `Regenerate all notes in "${label}"? This re-runs the full AI pipeline.`,
    successMsg: d => `Regenerating ${d.count} note${d.count !== 1 ? 's' : ''}…`,
    btn, course, module });
}

function startInlineRename(titleEl, noteId) {
  const current = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = `
    font-size:13px;font-weight:600;font-family:inherit;
    border:none;outline:none;background:var(--bg);
    box-shadow:0 0 0 2px var(--accent);border-radius:4px;
    padding:2px 6px;width:100%;color:var(--text);
  `;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || current;
    // Restore the title element
    titleEl.textContent = newTitle;
    input.replaceWith(titleEl);
    if (newTitle === current) return;
    try {
      await fetch(`/api/queue/${noteId}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      // Invalidate cache so next full refresh picks up new title
      lastQueueData = null;
    } catch (err) {
      console.error('Rename error:', err);
    }
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// Switch to grid and show approved notes
function showApprovedInGrid() {
  if (currentView !== 'grid') setView('grid');
  showApproved = !showApproved;
  lastQueueData = null;
  fetchQueue();
}

async function fetchQueue() {
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) throw new Error('Failed to fetch queue');
    const notes = await res.json();

    // Skip full re-render if nothing changed
    const serialized = JSON.stringify(notes) + showApproved;
    if (serialized === lastQueueData) return;
    lastQueueData = serialized;

    const container = document.getElementById('cards-container');
    container.innerHTML = '';

    const visible = showApproved ? notes : notes.filter(n => n.status !== 'approved' && n.status !== 'rejected');
    const hiddenCount = notes.filter(n => n.status === 'approved' || n.status === 'rejected').length;

    // Toggle chip
    const chip = document.getElementById('approved-chip');
    if (chip) {
      if (hiddenCount > 0 && !showApproved) {
        chip.textContent = `+ ${hiddenCount} approved`;
        chip.style.display = 'inline-flex';
      } else if (showApproved && hiddenCount > 0) {
        chip.textContent = 'Hide approved';
        chip.style.display = 'inline-flex';
      } else {
        chip.style.display = 'none';
      }
    }

    if (visible.length === 0) {
      renderEmptyState(container);
      if (currentView === 'graph') updateGraph(notes);
      return;
    }

    // Group notes: course → module → notes[]
    const groups = {};
    visible.forEach(note => {
      const course = note.course_name || 'Uncategorised';
      const mod = note.module_name || '__root__';
      if (!groups[course]) groups[course] = {};
      if (!groups[course][mod]) groups[course][mod] = [];
      groups[course][mod].push(note);
    });

    const tree = document.createElement('div');
    tree.className = 'file-tree';

    Object.keys(groups).sort().forEach(course => {
      const mods = groups[course];
      const totalNotes = Object.values(mods).flat().length;
      const courseEl = document.createElement('div');
      courseEl.className = 'ft-course';

      // Course row
      const courseRow = document.createElement('div');
      courseRow.className = 'ft-course-row';
      courseRow.innerHTML = `
        <span class="ft-chevron">▾</span>
        <span class="ft-icon">📚</span>
        <span class="ft-name">${escapeHtml(course)}</span>
        <span class="ft-badge">${totalNotes}</span>
        <button class="ft-approve ft-row-approve" title="Approve all in this course">✓</button>
        <button class="ft-regen ft-row-regen" title="Regenerate all in this course">↻</button>
        <button class="ft-trash ft-row-trash" title="Delete all in this course">🗑</button>
      `;
      courseRow.querySelector('.ft-approve').addEventListener('click', e => { e.stopPropagation(); approveBulk(course, undefined, course, e.currentTarget); });
      courseRow.querySelector('.ft-regen').addEventListener('click', e => { e.stopPropagation(); regenBulk(course, undefined, course, e.currentTarget); });
      courseRow.querySelector('.ft-trash').addEventListener('click', e => { e.stopPropagation(); deleteBulk(course, undefined, course, e.currentTarget); });
      const courseChildren = document.createElement('div');
      courseChildren.className = 'ft-children';
      courseRow.addEventListener('click', () => {
        const open = !courseEl.classList.contains('closed');
        courseEl.classList.toggle('closed', open);
        courseRow.querySelector('.ft-chevron').textContent = open ? '▸' : '▾';
      });
      courseEl.appendChild(courseRow);

      // Module rows
      Object.keys(mods).sort().forEach(mod => {
        const modNotes = mods[mod];
        const hasModName = mod !== '__root__';

        if (hasModName) {
          const modEl = document.createElement('div');
          modEl.className = 'ft-module';

          const modRow = document.createElement('div');
          modRow.className = 'ft-module-row';
          modRow.innerHTML = `
            <span class="ft-chevron">▾</span>
            <span class="ft-icon">📂</span>
            <span class="ft-name">${escapeHtml(mod)}</span>
            <span class="ft-badge">${modNotes.length}</span>
            <button class="ft-approve ft-row-approve" title="Approve all in this module">✓</button>
            <button class="ft-regen ft-row-regen" title="Regenerate all in this module">↻</button>
            <button class="ft-trash ft-row-trash" title="Delete all in this module">🗑</button>
          `;
          modRow.querySelector('.ft-approve').addEventListener('click', e => { e.stopPropagation(); approveBulk(course, mod, mod, e.currentTarget); });
          modRow.querySelector('.ft-regen').addEventListener('click', e => { e.stopPropagation(); regenBulk(course, mod, mod, e.currentTarget); });
          modRow.querySelector('.ft-trash').addEventListener('click', e => { e.stopPropagation(); deleteBulk(course, mod, mod, e.currentTarget); });
          const modChildren = document.createElement('div');
          modChildren.className = 'ft-children';
          modRow.addEventListener('click', e => {
            e.stopPropagation();
            const open = !modEl.classList.contains('closed');
            modEl.classList.toggle('closed', open);
            modRow.querySelector('.ft-chevron').textContent = open ? '▸' : '▾';
          });

          modNotes.forEach(note => modChildren.appendChild(renderNoteRow(note)));
          modEl.appendChild(modRow);
          modEl.appendChild(modChildren);
          courseChildren.appendChild(modEl);
        } else {
          modNotes.forEach(note => courseChildren.appendChild(renderNoteRow(note)));
        }
      });

      courseEl.appendChild(courseChildren);
      tree.appendChild(courseEl);
    });

    container.appendChild(tree);

    // Update graph if currently in graph view
    if (currentView === 'graph') updateGraph(notes);
  } catch (err) {
    console.error('Error fetching queue:', err);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    const dot = document.getElementById('watcher-dot');
    const label = document.getElementById('watcher-label');

    if (data.watcher_running) {
      dot.classList.add('active');
      label.textContent = 'Watcher: active';
    } else {
      dot.classList.remove('active');
      label.textContent = 'Watcher: stopped';
    }

    document.getElementById('queue-count').textContent = data.queue_size;
    document.getElementById('processing-count').textContent = data.processing_count;
  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

function refreshAll() {
  fetchQueue();
  fetchStatus();
}

// Initial load
refreshAll();

// Auto-refresh every 5 seconds; clean up on page unload
autoRefreshInterval = setInterval(refreshAll, 5000);
window.addEventListener('beforeunload', () => clearInterval(autoRefreshInterval));
