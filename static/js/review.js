// ===== Review Page JavaScript =====

// Extract note_id from URL path: /review/{note_id}
const pathParts = window.location.pathname.split('/');
const noteId = pathParts[pathParts.length - 1];

let currentNote = null;
let pollInterval = null;
let saveTimeout = null;
let isProcessing = false;

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Custom renderer — single canonical place for [[wikilink]] styling
const renderer = new marked.Renderer();
renderer.paragraph = (text) => {
  const styled = text.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" style="color:var(--accent);font-weight:500;text-decoration:none;background:var(--accent-subtle);padding:1px 4px;border-radius:4px;" title="Wikilink: $1">$1</a>');
  return `<p>${styled}</p>`;
};
marked.use({ renderer });

function updatePreview(markdown) {
  const preview = document.getElementById('markdown-preview');
  if (!markdown || markdown.trim() === '') {
    preview.innerHTML = '<p style="color:var(--muted);">No content yet...</p>';
    return;
  }
  try {
    // Let the marked renderer handle [[wikilinks]] — no pre-processing here
    preview.innerHTML = marked.parse(markdown);
  } catch (e) {
    preview.innerHTML = `<pre style="color:var(--danger);">${escapeHtml(markdown)}</pre>`;
  }
}

function renderScores(scores) {
  if (!scores) return;

  const section = document.getElementById('scores-section');
  const container = document.getElementById('scores-container');
  section.style.display = 'block';

  const dims = [
    { key: 'accuracy', label: 'Accuracy' },
    { key: 'completeness', label: 'Completeness' },
    { key: 'wikilink_density', label: 'Wikilink Density' },
  ];

  let html = '';
  dims.forEach(({ key, label }) => {
    const val = scores[key] || 0;
    const pct = (val / 10) * 100;
    const cls = val >= 7 ? 'high' : val >= 5 ? 'mid' : 'low';

    html += `
      <div class="score-item">
        <div class="score-label">
          <span>${label}</span>
          <span>${val}/10</span>
        </div>
        <div class="score-bar-track">
          <div class="score-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  });

  const goodEnough = scores.good_enough;
  html += `
    <div class="score-good ${goodEnough ? 'passed' : 'failed'}">
      ${goodEnough ? '✓ Passed quality check' : '✗ Quality check failed'}
    </div>
  `;

  if (scores.feedback) {
    html += `
      <div style="font-size:11px;color:var(--muted);margin-top:6px;padding:8px;background:var(--bg);border-radius:6px;border:1px solid var(--border);">
        <strong style="color:var(--text);">Feedback:</strong><br>
        ${escapeHtml(scores.feedback)}
      </div>
    `;
  }

  container.innerHTML = html;
}

function setProcessingState(processing) {
  isProcessing = processing;
  document.getElementById('processing-overlay').style.display = processing ? 'flex' : 'none';
  document.getElementById('approve-btn').disabled = processing;
  document.getElementById('reject-btn').disabled = processing;
  document.getElementById('regenerate-btn').disabled = processing;
  document.getElementById('markdown-editor').disabled = processing;
}

function updateStatusBadge(status) {
  const badge = document.getElementById('note-status-badge');
  const labels = {
    processing: '⏳ Processing',
    in_review: '👁 In Review',
    approved: '✓ Approved',
    rejected: '✗ Rejected'
  };
  badge.className = `badge badge-${status}`;
  badge.textContent = labels[status] || status;
}

function populateNote(note) {
  currentNote = note;

  // Navbar title (editable input — set value and auto-size)
  const titleInput = document.getElementById('nav-title');
  titleInput.value = note.title || 'Untitled';
  autoSizeTitle(titleInput);
  const courseBadge = document.getElementById('nav-course-badge');
  if (note.course_name) {
    courseBadge.textContent = note.course_name;
    courseBadge.style.display = 'inline-flex';
  }

  // Status
  updateStatusBadge(note.status);

  // Expansion level
  const expSelect = document.getElementById('expansion-select');
  if (note.expansion_level) expSelect.value = note.expansion_level;

  // Info section
  document.getElementById('course-input').value = note.course_name || '';
  document.getElementById('module-input').value = note.module_name || '';
  document.getElementById('info-loops').textContent = note.loop_count ?? '–';
  document.getElementById('info-images').textContent = (note.image_paths || []).length;
  document.getElementById('info-timestamp').textContent = formatAbsoluteTimestamp(note.timestamp);

  // Scores
  if (note.reflection_scores) renderScores(note.reflection_scores);

  // Search queries
  if (note.search_queries && note.search_queries.length > 0) {
    const section = document.getElementById('search-section');
    const list = document.getElementById('search-queries-list');
    section.style.display = 'block';
    list.innerHTML = note.search_queries
      .map(q => `<li style="margin-bottom:4px;">${escapeHtml(q)}</li>`)
      .join('');
  }

  // Processing state — resolve this FIRST so isProcessing is up-to-date
  if (note.status === 'processing') {
    setProcessingState(true);
    startPolling();
  } else {
    setProcessingState(false);
    stopPolling();
    // Only populate editor when note is ready (not mid-processing)
    const draft = note.draft_markdown || '';
    const editor = document.getElementById('markdown-editor');
    editor.value = draft;
    updatePreview(draft);
  }
}

async function loadNote() {
  if (!noteId) {
    showToast('Invalid note ID', 'error');
    return;
  }
  try {
    const res = await fetch(`/api/queue/${noteId}`);
    if (!res.ok) { showToast('Note not found', 'error'); return; }
    populateNote(await res.json());
  } catch (err) {
    showToast('Failed to load note', 'error');
    console.error(err);
  }
}

// Poll only for status change (lightweight), then fetch full note on completion
async function pollForCompletion() {
  try {
    const res = await fetch(`/api/queue/${noteId}/status`);
    if (!res.ok) return;
    const { status } = await res.json();
    if (status !== 'processing') {
      stopPolling();
      await loadNote();
      showToast('Note is ready for review!', 'success');
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollForCompletion, 3000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Auto-save draft with debounce
function onEditorInput() {
  updatePreview(document.getElementById('markdown-editor').value);

  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const markdown = document.getElementById('markdown-editor').value;
    try {
      const res = await fetch(`/api/queue/${noteId}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown })
      });
      if (res.ok) {
        const indicator = document.getElementById('save-indicator');
        indicator.classList.add('show');
        setTimeout(() => indicator.classList.remove('show'), 2000);
      }
    } catch (err) {
      console.error('Auto-save error:', err);
    }
  }, 2000);
}

async function approve() {
  const markdown = document.getElementById('markdown-editor').value;
  try {
    const res = await fetch(`/api/queue/${noteId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown })
    });
    if (!res.ok) throw new Error('Failed to approve');
    showToast('Note approved and saved to vault!', 'success');
    updateStatusBadge('approved');
    setTimeout(() => window.location.href = '/', 1200);
  } catch (err) {
    showToast('Failed to approve note', 'error');
    console.error(err);
  }
}

async function reject() {
  if (!confirm('Reject this note? It will remain in the queue but marked as rejected.')) return;
  try {
    const res = await fetch(`/api/queue/${noteId}/reject`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to reject');
    showToast('Note rejected', 'info');
    updateStatusBadge('rejected');
    setTimeout(() => window.location.href = '/', 1000);
  } catch (err) {
    showToast('Failed to reject note', 'error');
    console.error(err);
  }
}

async function regenerate() {
  const expansionLevel = document.getElementById('expansion-select').value;
  try {
    const res = await fetch(`/api/queue/${noteId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expansion_level: expansionLevel })
    });
    if (!res.ok) throw new Error('Failed to regenerate');
    showToast('Regenerating note...', 'info');
    setProcessingState(true);
    updateStatusBadge('processing');
    document.getElementById('markdown-editor').value = '';
    document.getElementById('markdown-preview').innerHTML = '<p style="color:var(--muted);">Regenerating...</p>';
    startPolling();
  } catch (err) {
    showToast('Failed to regenerate note', 'error');
    console.error(err);
  }
}

// Auto-size the title input to its content
function autoSizeTitle(input) {
  // Use a hidden span to measure text width
  let ruler = document.getElementById('_title_ruler');
  if (!ruler) {
    ruler = document.createElement('span');
    ruler.id = '_title_ruler';
    ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:14px;font-weight:600;pointer-events:none;';
    document.body.appendChild(ruler);
  }
  ruler.textContent = input.value || input.placeholder || ' ';
  input.style.width = (ruler.offsetWidth + 24) + 'px';
}

async function saveCourse(value) {
  const name = value.trim();
  if (!name) return;
  try {
    await fetch(`/api/queue/${noteId}/course`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_name: name })
    });
    // Also update the navbar course badge
    document.getElementById('nav-course-badge').textContent = name;
  } catch (err) {
    console.error('Course save error:', err);
  }
}

async function saveModule(value) {
  try {
    await fetch(`/api/queue/${noteId}/module`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module_name: value.trim() })
    });
  } catch (err) {
    console.error('Module save error:', err);
  }
}

async function saveTitle(rawValue) {
  const title = rawValue.trim() || 'Untitled Note';
  // Sync input back in case it was blank
  const input = document.getElementById('nav-title');
  input.value = title;
  autoSizeTitle(input);

  try {
    const res = await fetch(`/api/queue/${noteId}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (res.ok) {
      document.title = `${title} — FlashNote`;
      const indicator = document.getElementById('save-indicator');
      indicator.classList.add('show');
      setTimeout(() => indicator.classList.remove('show'), 2000);
    }
  } catch (err) {
    console.error('Title save error:', err);
  }
}

// Attach editor listener
document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('markdown-editor');
  editor.addEventListener('input', onEditorInput);

  const titleInput = document.getElementById('nav-title');
  titleInput.addEventListener('input', () => autoSizeTitle(titleInput));

  loadNote();
});
