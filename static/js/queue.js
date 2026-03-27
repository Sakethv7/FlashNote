// ===== Queue Page JavaScript =====

let autoRefreshInterval = null;
let lastQueueData = null; // change-detection cache
let currentSearchQuery = ''; // live search filter
let currentView = 'grid';
let showApproved = false; // approved notes hidden by default
// Track active consolidation jobs: job_key → {course, module, label}
const _activeConsolidations = {};

// Hover preview state
const previewCache = {};
let hoverTimeout = null;

// ===== Desktop Upload Modal =====
const DESKTOP_MAX = 15;
let desktopQueue = []; // [{file, objectUrl, isDoc}]
let desktopGroupSize = 1;
let desktopGroupMode = 'fixed'; // 'fixed' or 'auto'
let desktopExpansionLevel = 'detailed'; // 'concise' | 'detailed' | 'comprehensive'

function setDesktopExpansion(level, btn) {
  desktopExpansionLevel = level;
  document.querySelectorAll('[data-exp]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

const desktopGroupHints = {
  1: 'Each image → its own note, processed in order.',
  2: 'Every 2 consecutive images → 1 combined note.',
  3: 'Every 3 consecutive images → 1 rich chapter note.',
  auto: '🤖 AI analyses all images together and groups them by topic automatically.',
};

function desktopIsDoc(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return ext === 'pdf' || ext === 'txt' || ext === 'rtf';
}
function desktopDocIcon(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return ext === 'pdf' ? '📄' : '📝';
}

function setDesktopGroup(n, btn) {
  desktopGroupSize = n === 'auto' ? 1 : n;
  desktopGroupMode = n === 'auto' ? 'auto' : 'fixed';
  document.querySelectorAll('.desktop-group-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('desktop-group-hint').textContent = desktopGroupHints[n] || desktopGroupHints[1];
  updateDesktopUploadLabel();
}

function updateDesktopUploadLabel() {
  if (desktopQueue.length === 0) { document.getElementById('desktop-upload-btn').innerHTML = '↑ Upload & Generate'; return; }
  // Count images and docs in one pass
  let imgCount = 0, docCount = 0;
  desktopQueue.forEach(i => i.isDoc ? docCount++ : imgCount++);
  const ctxSuffix = docCount > 0 ? ' (+context)' : '';
  if (desktopGroupMode === 'auto') {
    document.getElementById('desktop-upload-btn').innerHTML = `🤖 Upload & Auto-Group${ctxSuffix}`;
  } else {
    const notes = imgCount > 0 ? Math.ceil(imgCount / desktopGroupSize) : docCount;
    document.getElementById('desktop-upload-btn').innerHTML =
      `↑ Upload & Generate ${notes} Note${notes > 1 ? 's' : ''}${ctxSuffix}`;
  }
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
  desktopQueue.forEach(i => { if (!i.isDoc && i.objectUrl) URL.revokeObjectURL(i.objectUrl); });
  desktopQueue = [];
  desktopGroupSize = 1;
  desktopGroupMode = 'fixed';
  desktopExpansionLevel = 'detailed';
  document.querySelectorAll('.desktop-group-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('[data-exp]').forEach((b, i) => b.classList.toggle('active', i === 1));
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
    const doc = desktopIsDoc(f);
    desktopQueue.push({ file: f, isDoc: doc, objectUrl: doc ? null : URL.createObjectURL(f) });
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
  const ctxSection = document.getElementById('desktop-context-section');
  const ctxList = document.getElementById('desktop-context-list');

  // Single pass: split queue into images (with original index) and docs
  const images = [], docs = [];
  desktopQueue.forEach((item, qIdx) => (item.isDoc ? docs : images).push({ item, qIdx }));

  if (desktopQueue.length === 0) {
    dropZone.style.display = '';
    thumbSection.style.display = 'none';
    if (ctxSection) ctxSection.style.display = 'none';
    addTile.style.display = 'none';
    return;
  }
  dropZone.style.display = 'none';
  addTile.style.display = desktopQueue.length >= DESKTOP_MAX ? 'none' : 'flex';

  // ── Image strip ──
  if (images.length > 0) {
    thumbSection.style.display = '';
    strip.querySelectorAll('.dt-wrap').forEach(el => el.remove());
    countBadge.textContent = `${images.length} image${images.length > 1 ? 's' : ''}`;
    images.forEach(({ item, qIdx }, imgIdx) => {
      const wrap = document.createElement('div');
      wrap.className = 'dt-wrap';
      wrap.style.cssText = 'position:relative;flex-shrink:0;width:68px;height:68px;';
      wrap.innerHTML = `
        <img src="${item.objectUrl}" style="width:68px;height:68px;object-fit:cover;border-radius:8px;border:1.5px solid var(--border);display:block;" />
        <div style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;border:2px solid var(--bg);font-size:10px;line-height:14px;text-align:center;cursor:pointer;font-weight:700;z-index:2;" data-rm>✕</div>
        <div style="position:absolute;bottom:3px;left:3px;background:rgba(0,0,0,0.5);color:#fff;font-size:9px;font-weight:600;border-radius:3px;padding:1px 4px;">${imgIdx+1}</div>`;
      wrap.querySelector('[data-rm]').addEventListener('click', e => {
        e.stopPropagation();
        if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
        desktopQueue.splice(qIdx, 1);
        renderDesktopThumbs(); checkDesktopReady();
      });
      strip.appendChild(wrap);
    });
  } else {
    thumbSection.style.display = 'none';
  }

  // ── Context docs section ──
  if (ctxSection && ctxList) {
    if (docs.length > 0) {
      ctxSection.style.display = '';
      ctxList.innerHTML = '';
      docs.forEach(({ item, qIdx }) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--accent-subtle);border:1px solid var(--border);border-radius:8px;';
        row.innerHTML = `
          <span style="font-size:18px;">${desktopDocIcon(item.file)}</span>
          <span style="flex:1;font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.file.name}</span>
          <span style="font-size:10px;color:var(--accent);font-weight:600;background:rgba(217,119,87,0.15);padding:2px 7px;border-radius:10px;">context</span>
          <span style="cursor:pointer;color:var(--muted);font-size:14px;font-weight:700;" data-rm>✕</span>`;
        row.querySelector('[data-rm]').addEventListener('click', () => {
          desktopQueue.splice(qIdx, 1);
          renderDesktopThumbs(); checkDesktopReady();
        });
        ctxList.appendChild(row);
      });
    } else {
      ctxSection.style.display = 'none';
    }
  }

  // Hide group size selector when only docs in queue — reuse already-computed images array
  const groupField = document.querySelector('.upload-modal-body .form-group:has(#desktop-group-hint)') ||
    document.getElementById('desktop-group-hint')?.closest('.form-group');
  if (groupField) groupField.style.display = images.length > 0 ? '' : 'none';

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
  progressLabel.textContent = desktopGroupMode === 'auto'
    ? `Uploading & analysing ${desktopQueue.length} image${desktopQueue.length > 1 ? 's' : ''} with AI…`
    : `Uploading ${desktopQueue.length} file${desktopQueue.length > 1 ? 's' : ''}…`;
  progressFill.style.width = '15%';

  // Send all files in one request — backend handles grouping
  const form = new FormData();
  desktopQueue.forEach(({ file }) => form.append('files', file));
  form.append('course_name', course);
  form.append('module_name', module);
  form.append('group_size', desktopGroupSize);
  form.append('group_mode', desktopGroupMode);
  form.append('expansion_level', desktopExpansionLevel);
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

    // Auto-grouping runs async — poll until done
    if (data.status === 'grouping' && data.batch_id) {
      progressLabel.textContent = `🤖 AI is grouping ${data.image_count} images into notes…`;
      progressFill.style.width = '40%';
      await pollAutoGrouping(data.batch_id, progressFill, progressLabel);
    } else if (data.status === 'skipped') {
      progressFill.style.width = '100%';
      showToast(`⚠ ${data.message}`, 'info');
    } else {
      const noteCount = data.count || 1;
      progressFill.style.width = '100%';
      await new Promise(r => setTimeout(r, 300));
      const dupNote = data.duplicates?.length ? ` (${data.duplicates.length} duplicate${data.duplicates.length > 1 ? 's' : ''} skipped)` : '';
      showToast(`${noteCount} note${noteCount > 1 ? 's' : ''} queued for processing!${dupNote}`, 'success');
    }

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

async function pollAutoGrouping(batchId, progressFill, progressLabel) {
  const maxWait = 120000; // 2 min timeout
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const s = await fetch(`/api/upload/group-status/${batchId}`).then(r => r.json());
      if (s.status === 'done') {
        progressFill.style.width = '100%';
        showToast(`✅ Auto-grouped into ${s.groups || '?'} notes — generating now!`, 'success');
        return;
      } else if (s.status === 'error') {
        showToast(`⚠️ Auto-group failed: ${s.message}. Falling back to 1 note per image.`, 'error');
        return;
      } else if (s.status === 'processing') {
        const pct = 40 + Math.min((s.done || 0) / (s.groups || 1) * 55, 55);
        progressFill.style.width = pct + '%';
        progressLabel.textContent = `🤖 Grouped into ${s.groups} notes, generating (${s.done || 0}/${s.groups})…`;
      }
    } catch (e) { /* keep polling */ }
  }
  showToast('Auto-grouping is taking long — notes will appear shortly.', 'info');
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

  const stageLabels = { extracting: 'Extracting…', searching: 'Searching…', visualizing: 'Visuals…', writing: 'Writing…', reflecting: 'Reflecting…', finalizing: 'Finishing…' };
  const stageLabel = note.status === 'processing' && note.pipeline_stage ? stageLabels[note.pipeline_stage] || 'Processing…' : null;
  const statusDot = { approved: '🟢', in_review: '🟡', processing: '🔵', rejected: '🔴', failed: '🔴' }[note.status] || '⚪';

  const canApprove = note.status === 'in_review';
  const seqBadge = note.sequence != null ? `<span class="ft-seq-badge">${note.sequence + 1}</span>` : '';
  row.innerHTML = `
    <input type="checkbox" class="ft-select-check" onclick="event.stopPropagation()" title="Select note" />
    ${seqBadge}
    <span class="ft-note-icon">${statusDot}</span>
    <span class="ft-note-title ft-editable-name" title="Double-click to rename">${escapeHtml(note.title || 'Untitled')}</span>
    ${stageLabel ? `<span class="ft-stage-label">${stageLabel}</span>` : ''}
    ${note.status === 'failed' && note.error_message ? `<span class="ft-error-label" title="${escapeHtml(note.error_message)}">⚠ Failed</span>` : ''}
    <span class="ft-note-time">${formatRelativeTimestamp(note.timestamp)}</span>
    <a href="/review/${note.note_id}" class="ft-note-open" title="Open">→</a>
    ${canApprove ? `<button class="ft-approve" title="Approve & save to Obsidian" onclick="event.stopPropagation()">✓</button>` : ''}
    ${note.status === 'failed' ? `<button class="ft-retry" title="Retry generation" onclick="event.stopPropagation()">↻ Retry</button>` : ''}
    <button class="ft-move" title="Move to module" onclick="event.stopPropagation()">📁</button>
    <button class="ft-reorder-up" title="Move up" onclick="event.stopPropagation()">↑</button>
    <button class="ft-reorder-down" title="Move down" onclick="event.stopPropagation()">↓</button>
    ${note.status !== 'failed' ? `<button class="ft-regen" title="Regenerate note" onclick="event.stopPropagation()">↻</button>` : ''}
    <button class="ft-trash" title="Delete note" onclick="event.stopPropagation()">🗑</button>
  `;

  // Double-click note title to rename inline
  row.querySelector('.ft-editable-name').addEventListener('dblclick', e => {
    e.stopPropagation();
    startInlineRename(e.currentTarget, note.note_id);
  });

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

  row.querySelector('.ft-move').addEventListener('click', e => {
    e.stopPropagation();
    openMovePopover(e.currentTarget, note);
  });

  const regenBtn = row.querySelector('.ft-regen');
  if (regenBtn) {
    regenBtn.addEventListener('click', async e => {
      e.stopPropagation();
      regenBtn.textContent = '…'; regenBtn.disabled = true;
      await fetch(`/api/queue/${note.note_id}/regenerate`, { method: 'POST',
        headers: {'Content-Type':'application/json'}, body: '{}' });
      lastQueueData = null; fetchQueue();
    });
  }

  const retryBtn = row.querySelector('.ft-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', async e => {
      e.stopPropagation();
      retryBtn.textContent = '…'; retryBtn.disabled = true;
      await fetch(`/api/queue/${note.note_id}/regenerate`, { method: 'POST',
        headers: {'Content-Type':'application/json'}, body: '{}' });
      lastQueueData = null; fetchQueue();
    });
  }

  row.querySelector('.ft-trash').addEventListener('click', async e => {
    e.stopPropagation();
    // Soft delete: remove from view immediately, show undo toast, actually delete after 5s
    row.style.opacity = '0.4';
    row.style.pointerEvents = 'none';
    showUndoToast(note.title || 'Untitled', note.note_id);
    // Remove from view after brief animation
    setTimeout(() => { row.remove(); }, 300);
  });

  // Hover preview
  row.addEventListener('mouseenter', () => {
    hoverTimeout = setTimeout(() => showPreview(note.note_id, row.getBoundingClientRect()), 200);
  });
  row.addEventListener('mouseleave', () => { clearTimeout(hoverTimeout); hidePreview(); });

  // ↑↓ manual reorder within siblings
  row.querySelector('.ft-reorder-up').addEventListener('click', async e => {
    e.stopPropagation();
    const siblings = [...row.parentElement.querySelectorAll('.ft-note-row')];
    const idx = siblings.indexOf(row);
    if (idx <= 0) return;
    row.parentElement.insertBefore(row, siblings[idx - 1]);
    await saveVisualOrder(row.parentElement);
  });
  row.querySelector('.ft-reorder-down').addEventListener('click', async e => {
    e.stopPropagation();
    const siblings = [...row.parentElement.querySelectorAll('.ft-note-row')];
    const idx = siblings.indexOf(row);
    if (idx >= siblings.length - 1) return;
    row.parentElement.insertBefore(siblings[idx + 1], row);
    await saveVisualOrder(row.parentElement);
  });

  // Checkbox for bulk selection
  row.querySelector('.ft-select-check').addEventListener('change', e => {
    e.stopPropagation();
    updateBulkBar();
  });

  // Click row to open review — ignore clicks on action buttons, the arrow, and the editable title
  row.addEventListener('click', e => {
    if (e.target.closest('.ft-approve, .ft-regen, .ft-retry, .ft-trash, .ft-move, .ft-note-open, .ft-editable-name, .ft-reorder-up, .ft-reorder-down, .ft-select-check')) return;
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

async function consolidateBulk(course, module, label, btn) {
  if (!confirm(`Consolidate notes in "${label}"?\n\nClaude will analyse all notes for overlap and merge duplicates into richer combined notes. This may take 30–90 seconds.`)) return;
  const original = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  const params = new URLSearchParams();
  if (course) params.set('course_name', course);
  if (module !== undefined && module !== null) params.set('module_name', module);
  try {
    const res = await fetch(`/api/queue/consolidate?${params}`, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'skipped') {
      showToast(data.reason, 'info');
    } else {
      const jobKey = data.job_key;
      // Clear any existing poll interval for this job before starting a new one
      if (_activeConsolidations[jobKey]?.interval) clearInterval(_activeConsolidations[jobKey].interval);
      _activeConsolidations[jobKey] = { course, module, label };
      showConsolidationIndicator(`Consolidating "${label}" (${data.count} notes)…`);
      pollConsolidation(jobKey, course, module, label);
    }
  } catch (err) {
    showToast('Consolidation request failed', 'error');
  } finally {
    btn.textContent = original; btn.disabled = false;
  }
}

function showConsolidationIndicator(msg) {
  const el = document.getElementById('consolidation-indicator');
  const lbl = document.getElementById('consolidation-label');
  if (el && lbl) { lbl.textContent = msg; el.style.display = 'flex'; }
}

function hideConsolidationIndicator() {
  const el = document.getElementById('consolidation-indicator');
  if (el) el.style.display = 'none';
}

async function pollConsolidation(jobKey, course, module, label) {
  const params = new URLSearchParams();
  if (course) params.set('course_name', course);
  if (module !== undefined && module !== null) params.set('module_name', module);

  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/queue/consolidate/status?${params}`);
      const data = await res.json();
      if (data.status === 'running') {
        showConsolidationIndicator(`"${label}": ${data.message || 'Consolidating…'}`);
      } else if (data.status === 'done') {
        clearInterval(interval);
        delete _activeConsolidations[jobKey];
        if (Object.keys(_activeConsolidations).length === 0) hideConsolidationIndicator();
        showToast(`✓ ${data.message}`, 'success');
        lastQueueData = null; fetchQueue();
      } else if (data.status === 'error') {
        clearInterval(interval);
        delete _activeConsolidations[jobKey];
        if (Object.keys(_activeConsolidations).length === 0) hideConsolidationIndicator();
        showToast(`Consolidation failed: ${data.message}`, 'error');
      }
    } catch {}
  }, 4000);
  // Store the interval so it can be cleared if consolidate is triggered again
  if (_activeConsolidations[jobKey]) _activeConsolidations[jobKey].interval = interval;
}

// ── Smart Merge ──

async function smartMergeBulk(course, module, btn) {
  const label = module || course;
  const noteCount = lastQueueData ? lastQueueData.filter(n =>
    (!course || n.course_name === course) &&
    (module === undefined || module === null || n.module_name === module) &&
    ['in_review','pending'].includes(n.status) && n.draft_markdown
  ).length : '?';
  if (!confirm(`Merge similar notes in "${label}" into fewer, denser notes?\n\n${noteCount} notes → roughly ${Math.max(1, Math.round(noteCount/3))} merged notes.\n\nOriginals will be replaced. This cannot be undone.`)) return;
  const original = btn.textContent;
  btn.textContent = '⏳'; btn.disabled = true;
  const params = new URLSearchParams();
  if (course) params.set('course_name', course);
  if (module !== undefined && module !== null) params.set('module_name', module);
  try {
    const res = await fetch(`/api/queue/smart-merge?${params}`, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'skipped') {
      showToast(data.message, 'info');
    } else if (data.status === 'merging') {
      showToast(`🔀 Merging ${data.notes_in_pool} notes into ~${data.target_groups}… Refresh in a moment.`, 'success');
      setTimeout(() => { lastQueueData = null; fetchQueue(); }, 4000);
    } else {
      showToast(`Merge failed: ${data.message || 'unknown error'}`, 'error');
    }
  } catch (err) {
    showToast('Smart merge request failed', 'error');
  } finally {
    btn.textContent = original; btn.disabled = false;
  }
}

// ── Smart Order ──

async function smartOrderBulk(course, module, btn) {
  const label = module || course;
  if (!confirm(`Let AI suggest the best reading order for notes in "${label}"?\n\nThis uses Claude to sequence notes by topic logic. You can adjust manually afterwards.`)) return;
  const original = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  const params = new URLSearchParams();
  if (course) params.set('course_name', course);
  if (module !== undefined && module !== null) params.set('module_name', module);
  try {
    const res = await fetch(`/api/queue/smart-order?${params}`, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'skipped') {
      showToast(data.reason, 'info');
    } else if (data.status === 'done') {
      showToast(`🗂 Notes reordered: ${data.titles.slice(0, 3).join(' → ')}${data.titles.length > 3 ? '…' : ''}`, 'success');
      lastQueueData = null; fetchQueue();
    } else {
      showToast(`Smart order failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast('Smart order request failed', 'error');
  } finally {
    btn.textContent = original; btn.disabled = false;
  }
}

async function saveVisualOrder(container) {
  const noteIds = [...container.querySelectorAll('.ft-note-row')].map(r => r.dataset.noteId);
  if (!noteIds.length) return;
  await fetch('/api/queue/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note_ids: noteIds })
  });
  // Update sequence badges visually without full re-render
  container.querySelectorAll('.ft-note-row').forEach((r, i) => {
    let badge = r.querySelector('.ft-seq-badge');
    if (!badge) { badge = document.createElement('span'); badge.className = 'ft-seq-badge'; r.prepend(badge); }
    badge.textContent = i + 1;
  });
}

// ── Move-to-module popover ──
let _movePopover = null;

function openMovePopover(btn, note) {
  // Close any existing popover
  if (_movePopover) { _movePopover.remove(); _movePopover = null; }

  // Collect existing module names for this course from the current tree data
  const existingModules = new Set();
  if (lastQueueData) {
    try {
      const parsed = JSON.parse(lastQueueData.replace(/true$|false$/, ''));
      parsed.forEach(n => {
        if (n.course_name === note.course_name && n.module_name && n.module_name !== note.module_name) {
          existingModules.add(n.module_name);
        }
      });
    } catch {}
  }

  const pop = document.createElement('div');
  pop.className = 'move-popover';
  pop.innerHTML = `
    <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:6px;">Move to module</div>
    <input class="move-input" type="text" placeholder="Module name (or leave blank for root)"
      list="move-module-list" autocomplete="off" />
    <datalist id="move-module-list">
      ${[...existingModules].map(m => `<option value="${escapeHtml(m)}"></option>`).join('')}
      <option value=""></option>
    </datalist>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="btn btn-primary move-confirm" style="flex:1;font-size:12px;padding:5px 10px;">Move</button>
      <button class="btn btn-ghost move-cancel" style="font-size:12px;padding:5px 10px;">✕</button>
    </div>
  `;
  _movePopover = pop;

  // Position below the button
  document.body.appendChild(pop);
  const rect = btn.getBoundingClientRect();
  pop.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  pop.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 220) + 'px';

  const input = pop.querySelector('.move-input');
  input.value = note.module_name || '';
  input.focus(); input.select();

  async function doMove() {
    const newModule = input.value.trim();
    if (newModule === (note.module_name || '')) { closePopover(); return; }
    pop.querySelector('.move-confirm').textContent = '…';
    await fetch(`/api/queue/${note.note_id}/module`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module_name: newModule }),
    });
    closePopover();
    showToast(`Moved to "${newModule || '(root)'}"`, 'success');
    lastQueueData = null; fetchQueue();
  }

  function closePopover() { if (_movePopover) { _movePopover.remove(); _movePopover = null; } }

  pop.querySelector('.move-confirm').addEventListener('click', doMove);
  pop.querySelector('.move-cancel').addEventListener('click', closePopover);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') doMove();
    if (e.key === 'Escape') closePopover();
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target)) { closePopover(); document.removeEventListener('click', handler); }
    });
  }, 50);
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

// Rename course or module in-place — updates all matching notes via bulk PATCH
async function startInlineBulkRename(nameEl, type, course, module) {
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = `
    font-size:13px;font-weight:600;font-family:inherit;
    border:none;outline:none;background:var(--bg);
    box-shadow:0 0 0 2px var(--accent);border-radius:4px;
    padding:2px 6px;width:160px;color:var(--text);
  `;
  nameEl.replaceWith(input);
  input.focus(); input.select();

  async function commit() {
    const newName = input.value.trim() || current;
    nameEl.textContent = newName;
    input.replaceWith(nameEl);
    if (newName === current) return;

    // Fetch all notes then filter client-side to exact scope
    // (/api/queue has no filter params — filter here to avoid renaming everything)
    const allNotes = await fetch('/api/queue').then(r => r.json()).catch(() => []);
    const scopedNotes = type === 'course'
      ? allNotes.filter(n => n.course_name === course)
      : allNotes.filter(n => n.course_name === course && n.module_name === module);

    const field    = type === 'course' ? 'course_name' : 'module_name';
    const endpoint = type === 'course' ? 'course' : 'module';
    await Promise.all(scopedNotes.map(n =>
      fetch(`/api/queue/${n.note_id}/${endpoint}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: newName }),
      })
    ));
    showToast(`Renamed "${current}" → "${newName}" (${scopedNotes.length} note${scopedNotes.length !== 1 ? 's' : ''})`, 'success');
    lastQueueData = null; fetchQueue();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
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

    const q = currentSearchQuery.toLowerCase().trim();
    const visible = (showApproved ? notes : notes.filter(n => n.status !== 'approved' && n.status !== 'rejected'))
      .filter(n => {
        if (!q) return true;
        if ((n.title || '').toLowerCase().includes(q)) return true;
        if ((n.module_name || '').toLowerCase().includes(q)) return true;
        if ((n.course_name || '').toLowerCase().includes(q)) return true;
        if (Array.isArray(n.tags) && n.tags.some(t => t.toLowerCase().includes(q))) return true;
        if (Array.isArray(n.wikilinks) && n.wikilinks.some(w => w.toLowerCase().includes(q))) return true;
        return false;
      });
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
        <span class="ft-name ft-editable-name" title="Double-click to rename">${escapeHtml(course)}</span>
        <span class="ft-badge">${totalNotes}</span>
        <button class="ft-consolidate ft-row-consolidate" title="Consolidate duplicates in this course (AI)">🔀</button>
        <button class="ft-smartorder ft-row-smartorder" title="Smart order notes in this course (AI)">🗂</button>
        <button class="ft-smartmerge ft-row-smartmerge" title="Smart merge similar notes into fewer dense notes (AI)">⊕</button>
        <button class="ft-approve ft-row-approve" title="Approve all in this course">✓</button>
        <button class="ft-regen ft-row-regen" title="Regenerate all in this course">↻</button>
        <button class="ft-trash ft-row-trash" title="Delete all in this course">🗑</button>
      `;
      courseRow.querySelector('.ft-consolidate').addEventListener('click', e => { e.stopPropagation(); consolidateBulk(course, undefined, course, e.currentTarget); });
      courseRow.querySelector('.ft-smartorder').addEventListener('click', e => { e.stopPropagation(); smartOrderBulk(course, undefined, e.currentTarget); });
      courseRow.querySelector('.ft-smartmerge').addEventListener('click', e => { e.stopPropagation(); smartMergeBulk(course, undefined, e.currentTarget); });
      courseRow.querySelector('.ft-approve').addEventListener('click', e => { e.stopPropagation(); approveBulk(course, undefined, course, e.currentTarget); });
      courseRow.querySelector('.ft-regen').addEventListener('click', e => { e.stopPropagation(); regenBulk(course, undefined, course, e.currentTarget); });
      courseRow.querySelector('.ft-trash').addEventListener('click', e => { e.stopPropagation(); deleteBulk(course, undefined, course, e.currentTarget); });
      // Double-click course name to rename
      courseRow.querySelector('.ft-editable-name').addEventListener('dblclick', e => {
        e.stopPropagation();
        startInlineBulkRename(e.currentTarget, 'course', course, undefined);
      });
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
            <span class="ft-name ft-editable-name" title="Double-click to rename">${escapeHtml(mod)}</span>
            <span class="ft-badge">${modNotes.length}</span>
            <button class="ft-consolidate ft-row-consolidate" title="Consolidate duplicates in this module (AI)">🔀</button>
            <button class="ft-smartorder ft-row-smartorder" title="Smart order notes in this module (AI)">🗂</button>
            <button class="ft-smartmerge ft-row-smartmerge" title="Smart merge similar notes into fewer dense notes (AI)">⊕</button>
            <button class="ft-approve ft-row-approve" title="Approve all in this module">✓</button>
            <button class="ft-regen ft-row-regen" title="Regenerate all in this module">↻</button>
            <button class="ft-trash ft-row-trash" title="Delete all in this module">🗑</button>
          `;
          modRow.querySelector('.ft-consolidate').addEventListener('click', e => { e.stopPropagation(); consolidateBulk(course, mod, mod, e.currentTarget); });
          modRow.querySelector('.ft-smartorder').addEventListener('click', e => { e.stopPropagation(); smartOrderBulk(course, mod, e.currentTarget); });
          modRow.querySelector('.ft-smartmerge').addEventListener('click', e => { e.stopPropagation(); smartMergeBulk(course, mod, e.currentTarget); });
          modRow.querySelector('.ft-approve').addEventListener('click', e => { e.stopPropagation(); approveBulk(course, mod, mod, e.currentTarget); });
          modRow.querySelector('.ft-regen').addEventListener('click', e => { e.stopPropagation(); regenBulk(course, mod, mod, e.currentTarget); });
          modRow.querySelector('.ft-trash').addEventListener('click', e => { e.stopPropagation(); deleteBulk(course, mod, mod, e.currentTarget); });
          // Double-click module name to rename
          modRow.querySelector('.ft-editable-name').addEventListener('dblclick', e => {
            e.stopPropagation();
            startInlineBulkRename(e.currentTarget, 'module', course, mod);
          });
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

    const queueEl = document.getElementById('queue-count');
    const procEl  = document.getElementById('processing-count');

    queueEl.textContent = data.queue_size;
    queueEl.className = 'stat-pill stat-queue' + (data.queue_size > 0 ? ' active' : '');

    procEl.textContent = data.processing_count;
    procEl.className = 'stat-pill stat-processing' + (data.processing_count > 0 ? ' active' : '');
  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

function refreshAll() {
  fetchQueue();
  fetchStatus();
}

// ── Bulk selection ──

function getSelectedNoteIds() {
  return [...document.querySelectorAll('.ft-select-check:checked')]
    .map(cb => cb.closest('.ft-note-row')?.dataset.noteId).filter(Boolean);
}

function updateBulkBar() {
  const ids = getSelectedNoteIds();
  const bar = document.getElementById('bulk-bar');
  const count = document.getElementById('bulk-count');
  if (!bar) return;
  if (ids.length > 0) {
    bar.style.display = 'flex';
    count.textContent = `${ids.length} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function clearBulkSelection() {
  document.querySelectorAll('.ft-select-check:checked').forEach(cb => cb.checked = false);
  updateBulkBar();
}

async function bulkApproveSelected() {
  const ids = getSelectedNoteIds();
  if (!ids.length) return;
  if (!confirm(`Approve ${ids.length} note(s) and save to vault?`)) return;
  await Promise.all(ids.map(id => fetch(`/api/queue/${id}/approve`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })));
  clearBulkSelection();
  lastQueueData = null; fetchQueue();
  showToast(`✓ ${ids.length} note(s) approved`, 'success');
}

async function bulkDeleteSelected() {
  const ids = getSelectedNoteIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} note(s) permanently?`)) return;
  await Promise.all(ids.map(id => fetch(`/api/queue/${id}`, { method: 'DELETE' })));
  clearBulkSelection();
  lastQueueData = null; fetchQueue();
  showToast(`Deleted ${ids.length} note(s)`, 'info');
}

async function bulkChangeCourse() {
  const ids = getSelectedNoteIds();
  if (!ids.length) return;
  const course = prompt('Move selected notes to course:');
  if (!course?.trim()) return;
  await Promise.all(ids.map(id => fetch(`/api/queue/${id}/course`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ course_name: course.trim() }) })));
  clearBulkSelection();
  lastQueueData = null; fetchQueue();
  showToast(`Moved ${ids.length} note(s) to "${course.trim()}"`, 'success');
}

async function bulkChangeModule() {
  const ids = getSelectedNoteIds();
  if (!ids.length) return;
  const mod = prompt('Move selected notes to module:');
  if (mod === null) return;
  await Promise.all(ids.map(id => fetch(`/api/queue/${id}/module`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ module_name: mod.trim() }) })));
  clearBulkSelection();
  lastQueueData = null; fetchQueue();
  showToast(`Moved ${ids.length} note(s) to module "${mod.trim()}"`, 'success');
}

// ── Search filter ──
function filterNotes(query) {
  currentSearchQuery = query;
  lastQueueData = null; // force re-render
  fetchQueue();
}

// ── Undo delete ──
let _undoDeleteTimer = null;
let _undoDeleteNote = null;

function showUndoToast(noteTitle, noteId) {
  // If another delete was pending, execute it now before starting new timer
  if (_undoDeleteTimer) {
    clearTimeout(_undoDeleteTimer);
    if (_undoDeleteNote) {
      fetch(`/api/queue/${_undoDeleteNote}`, { method: 'DELETE' });
    }
    _undoDeleteNote = null;
  }
  _undoDeleteNote = noteId;

  let toast = document.getElementById('undo-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'undo-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:24px;font-size:13px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.3);transition:opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>Deleted "${escapeHtml(noteTitle.slice(0,40))}"</span><button onclick="undoDelete()" style="background:#e8956d;color:#fff;border:none;border-radius:12px;padding:3px 10px;cursor:pointer;font-size:12px;font-weight:600;">Undo</button>`;
  toast.style.opacity = '1';
  toast.style.display = 'flex';

  _undoDeleteTimer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; _undoDeleteNote = null; }, 300);
    // Actually delete permanently after undo window expires
    if (_undoDeleteNote) {
      fetch(`/api/queue/${_undoDeleteNote}`, { method: 'DELETE' });
      _undoDeleteNote = null;
    }
  }, 5000);
}

async function undoDelete() {
  if (_undoDeleteTimer) clearTimeout(_undoDeleteTimer);
  _undoDeleteNote = null;
  const toast = document.getElementById('undo-toast');
  if (toast) { toast.style.opacity = '0'; setTimeout(() => toast.style.display = 'none', 300); }
  lastQueueData = null;
  fetchQueue();
  showToast('Deletion undone', 'success');
}

// Initial load
refreshAll();

// Auto-refresh every 5 seconds; clean up on page unload
autoRefreshInterval = setInterval(refreshAll, 5000);
window.addEventListener('beforeunload', () => clearInterval(autoRefreshInterval));
