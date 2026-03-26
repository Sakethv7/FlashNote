// ===== Settings Page JavaScript =====
// showToast, escapeHtml loaded from utils.js

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to load settings');
    const data = await res.json();

    // Show .env key status
    const setEnvStatus = (elId, isSet, label = '') => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (isSet) {
        el.textContent = '✓ set';
        el.className = 'env-status set';
      } else {
        el.textContent = '✗ not set' + (label ? ` — add ${label} to .env` : '');
        el.className = 'env-status unset';
      }
    };
    setEnvStatus('anthropic-status', data.anthropic_api_key_set, 'ANTHROPIC_API_KEY');
    setEnvStatus('tavily-status',    data.tavily_api_key_set,    'TAVILY_API_KEY');

    document.getElementById('expansion-level').value = data.default_expansion_level || 'detailed';
    document.getElementById('port').value = data.port || 8765;

  } catch (err) {
    showToast('Failed to load settings', 'error');
    console.error(err);
  }
}

async function saveSettings() {
  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const updates = {};
  const expansionLevel = document.getElementById('expansion-level').value;
  const port = parseInt(document.getElementById('port').value, 10);

  if (expansionLevel) updates.default_expansion_level = expansionLevel;
  if (!isNaN(port) && port > 1023 && port < 65536) updates.port = port;

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error('Save failed');
    showToast('Settings saved!', 'success');

    setTimeout(() => loadSettings(), 400);
  } catch (err) {
    showToast('Failed to save settings', 'error');
    console.error(err);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
}

async function resyncVault() {
  const btn = document.getElementById('resync-btn');
  const result = document.getElementById('resync-result');
  btn.disabled = true; btn.textContent = '↻ Re-syncing…';
  result.style.display = 'none';
  try {
    const res = await fetch('/api/vault/resync', { method: 'POST' });
    const data = await res.json();
    result.style.display = 'block';
    if (data.failed === 0) {
      result.style.color = 'var(--success)';
      result.textContent = `✓ Re-synced ${data.resynced} note${data.resynced !== 1 ? 's' : ''} to vault.`;
    } else {
      result.style.color = 'var(--warning)';
      result.textContent = `${data.resynced} synced, ${data.failed} failed. Check console for details.`;
      console.error('Resync errors:', data.errors);
    }
    showToast(`Re-synced ${data.resynced} notes to vault`, 'success');
  } catch (err) {
    result.style.display = 'block'; result.style.color = 'var(--danger)';
    result.textContent = 'Re-sync failed. Is the server running?';
  } finally {
    btn.disabled = false; btn.textContent = '↻ Re-sync All Approved Notes → Vault';
  }
}

// Allow pressing Enter in text fields to save
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveSettings();
});

// ===== Course Management =====

async function loadCourses() {
  try {
    const res = await fetch('/api/courses');
    if (!res.ok) throw new Error('Failed to load courses');
    const courses = await res.json();
    const container = document.getElementById('courses-list');

    if (courses.length === 0) {
      container.innerHTML = '<p style="color:var(--muted);font-size:13px;margin-bottom:12px;">No courses yet. Add one below.</p>';
      return;
    }

    // Build DOM safely using escapeHtml to prevent XSS
    container.innerHTML = courses.map(c => `
      <div class="course-card" id="course-${escapeHtml(c.id)}">
        <div class="course-card-header">📁 ${escapeHtml(c.course_name || 'Untitled Course')}</div>
        <div class="field-row">
          <div class="field">
            <label>Course Name</label>
            <input type="text" id="name-${escapeHtml(c.id)}" value="${escapeHtml(c.course_name)}" placeholder="e.g. Agentic AI, Deep Learning…"
              oninput="document.querySelector('#course-${escapeHtml(c.id)} .course-card-header').textContent = '📁 ' + (this.value || 'Untitled Course')" />
          </div>
          <div class="field">
            <label>Watch Folder <span style="font-weight:400;color:var(--muted);font-size:11px;">(optional — for drag-and-drop screenshots)</span></label>
            <input type="text" id="folder-${escapeHtml(c.id)}" value="${escapeHtml(c.folder_path)}" placeholder="Leave blank if using phone upload only" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Expansion Level</label>
            <select id="expansion-${escapeHtml(c.id)}">
              <option value="brief" ${c.expansion_level === 'brief' ? 'selected' : ''}>Brief</option>
              <option value="detailed" ${c.expansion_level === 'detailed' ? 'selected' : ''}>Detailed</option>
              <option value="deep_dive" ${c.expansion_level === 'deep_dive' ? 'selected' : ''}>Deep Dive</option>
            </select>
          </div>
          <div class="field">
            <label>Tags (comma-separated)</label>
            <input type="text" id="tags-${escapeHtml(c.id)}" value="${escapeHtml((c.tags || []).join(', '))}" placeholder="e.g. ml, coursera" />
          </div>
        </div>
        <div class="course-card-actions">
          <button class="btn-delete-course" onclick="deleteCourse('${escapeHtml(c.id)}')">Delete</button>
          <button class="btn-save-course" onclick="saveCourse('${escapeHtml(c.id)}')">Save</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('Failed to load courses', 'error');
    console.error(err);
  }
}

async function addCourse() {
  try {
    const res = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_name: 'New Course', folder_path: '', expansion_level: 'detailed', tags: [], vault_path: '' })
    });
    if (!res.ok) {
      const e = await res.json();
      showToast('Error: ' + (e.detail || 'Could not add course'), 'error');
      return;
    }
    loadCourses();
  } catch (err) {
    showToast('Failed to add course', 'error');
    console.error(err);
  }
}

async function saveCourse(id) {
  const name = document.getElementById('name-' + id).value;
  const folder = document.getElementById('folder-' + id).value;
  const expansion = document.getElementById('expansion-' + id).value;
  const tags = document.getElementById('tags-' + id).value.split(',').map(t => t.trim()).filter(Boolean);
  try {
    const res = await fetch('/api/courses/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_name: name, folder_path: folder, expansion_level: expansion, tags })
    });
    if (!res.ok) {
      const e = await res.json();
      showToast('Error: ' + (e.detail || 'Could not save'), 'error');
      return;
    }
    loadCourses();
    showToast('Course saved!', 'success');
  } catch (err) {
    showToast('Failed to save course', 'error');
    console.error(err);
  }
}

async function deleteCourse(id) {
  if (!confirm('Delete this course? The folder and its screenshots will not be deleted.')) return;
  try {
    const res = await fetch('/api/courses/' + id, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Failed to delete course', 'error');
      return;
    }
    loadCourses();
    showToast('Course deleted', 'info');
  } catch (err) {
    showToast('Failed to delete course', 'error');
    console.error(err);
  }
}

// Load on page load
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadCourses();
});
