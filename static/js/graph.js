// ===== Force-Directed Graph with Wikilink Nodes =====

// Claude-palette course colors
const COURSE_PALETTE = [
  '#d97757','#c4673f','#a85432','#e8956d',
  '#8b6f5e','#6b4f40','#b8816a','#d4a898'
];

const PHYSICS = { REPULSION: 1200, SPRING_LEN: 100, SPRING_K: 0.04, GRAVITY: 0.002, DAMPING: 0.86 };
const WIKI_COLOR_LIGHT = '#7c5cbf';   // purple — distinct from orange note nodes
const WIKI_COLOR_DARK  = '#9d7de8';

let graphNodes = [];
let graphEdges = [];
let allNotes   = [];
let animFrameId = null;
let dragNode    = null;
let courseColorMap = {};
let courseList  = [];
let canvasInitialized = false;

// Multi-select filter state — empty Set = "all"
let selectedCourses = new Set();
let selectedModules = new Set();

// ── helpers ──────────────────────────────────────────────────────────────────

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function getCourseColor(course) {
  if (!courseColorMap[course]) {
    const idx = courseList.indexOf(course);
    courseColorMap[course] = COURSE_PALETTE[Math.max(idx, 0) % COURSE_PALETTE.length];
  }
  return courseColorMap[course];
}

// ── canvas init ───────────────────────────────────────────────────────────────

function initCanvas() {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas || canvasInitialized) return;
  canvasInitialized = true;

  const container = document.getElementById('graph-container');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = container.clientWidth  * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width  = container.clientWidth  + 'px';
    canvas.style.height = container.clientHeight + 'px';
    canvas.getContext('2d').scale(dpr, dpr);
    if (graphNodes.length > 0) startSimulation();
  }
  window.addEventListener('resize', resize);
  resize();

  const tooltip = document.getElementById('graph-tooltip');

  canvas.addEventListener('mousemove', e => {
    const { x, y } = canvasXY(e, canvas);
    if (dragNode) { dragNode.x = x; dragNode.y = y; dragNode.vx = 0; dragNode.vy = 0; return; }
    const hit = hitTest(x, y);
    canvas.style.cursor = hit ? 'pointer' : 'default';
    if (hit) {
      tooltip.textContent = hit.isWiki
        ? `[[${hit.label}]] — ${hit.noteCount} note${hit.noteCount !== 1 ? 's' : ''}`
        : `${hit.label}${hit.course ? '  ·  ' + hit.course : ''}${hit.module ? ' / ' + hit.module : ''}`;
      tooltip.style.left = (x + 16) + 'px';
      tooltip.style.top  = (y - 10) + 'px';
      tooltip.classList.add('visible');
    } else {
      tooltip.classList.remove('visible');
    }
  });

  let mouseDownXY = null; // track where mouse actually pressed down

  canvas.addEventListener('mousedown', e => {
    const { x, y } = canvasXY(e, canvas);
    mouseDownXY = { x, y };
    const hit = hitTest(x, y);
    if (hit) dragNode = hit;
  });

  canvas.addEventListener('mouseup', e => {
    if (!dragNode) return;
    const { x, y } = canvasXY(e, canvas);
    // Compare mouse positions (not node positions — nodes move during physics)
    const moved = mouseDownXY ? Math.hypot(x - mouseDownXY.x, y - mouseDownXY.y) : 99;
    if (moved < 8) {
      if (dragNode.noteId) {
        // Note node → open review page
        window.location.href = '/review/' + dragNode.noteId;
      } else if (dragNode.isWiki) {
        // Wikilink node → switch to grid, show approved too, search for this term
        setView('grid');
        // Show approved notes when coming from graph so wikilinked notes are visible
        if (typeof showApproved !== 'undefined') showApproved = true;
        const chip = document.getElementById('approved-chip');
        if (chip) chip.style.display = 'none'; // hide chip, we're showing all
        const searchInput = document.getElementById('notes-search');
        if (searchInput) {
          searchInput.value = dragNode.label;
          filterNotes(dragNode.label);
        }
      }
    }
    dragNode = null;
    mouseDownXY = null;
  });

  window.addEventListener('blur', () => { dragNode = null; mouseDownXY = null; });

  canvas.addEventListener('mouseleave', () => {
    dragNode = null;
    tooltip.classList.remove('visible');
    canvas.style.cursor = 'default';
  });
}

function canvasXY(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function hitTest(x, y) {
  // Wikilinks are diamonds — use axis-aligned bounding box (Manhattan distance for diamond)
  for (const n of graphNodes) {
    if (!n.isWiki) continue;
    const s = n.r * 1.25 + 6; // diamond half-size + hit padding
    if (Math.abs(x - n.x) + Math.abs(y - n.y) <= s) return n;
  }
  for (const n of graphNodes) if (!n.isWiki && Math.hypot(x - n.x, y - n.y) <= n.r + 4) return n;
  return null;
}

// ── filter panel ──────────────────────────────────────────────────────────────

function buildFilterPanel(notes) {
  const courses = [...new Set(notes.map(n => n.course_name).filter(Boolean))].sort();
  courseList = courses;

  const cf = document.getElementById('graph-course-filters');
  const mf = document.getElementById('graph-module-filters');
  const allBtn = document.getElementById('graph-all-btn');
  if (!cf || !mf) return;

  // Course chips (multi-select toggles)
  cf.innerHTML = courses.map(c => {
    const color = COURSE_PALETTE[courses.indexOf(c) % COURSE_PALETTE.length];
    const active = selectedCourses.has(c) ? 'active' : '';
    return `<button class="graph-filter-btn course-chip ${active}"
      style="--chip-color:${color};"
      data-course="${escapeHtmlAttr(c)}"
      onclick="toggleCourse('${escapeHtmlAttr(c)}')">${c}</button>`;
  }).join('');

  // Module chips — only show modules from selected courses (or all if none selected)
  refreshModuleChips(notes);

  // All button state
  if (allBtn) allBtn.classList.toggle('active', selectedCourses.size === 0 && selectedModules.size === 0);
}

function refreshModuleChips(notes) {
  const mf = document.getElementById('graph-module-filters');
  if (!mf) return;
  const source = selectedCourses.size > 0
    ? notes.filter(n => selectedCourses.has(n.course_name))
    : notes;
  const modules = [...new Set(source.map(n => n.module_name).filter(Boolean))].sort();

  if (modules.length === 0) { mf.innerHTML = ''; return; }

  mf.innerHTML = `<span class="graph-filter-label" style="font-size:11px;opacity:0.6;">Modules</span>` +
    modules.map(m => {
      const active = selectedModules.has(m) ? 'active' : '';
      return `<button class="graph-filter-btn module-chip ${active}"
        data-module="${escapeHtmlAttr(m)}"
        onclick="toggleModule('${escapeHtmlAttr(m)}')">${m}</button>`;
    }).join('');
}

function escapeHtmlAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function toggleCourse(course) {
  if (selectedCourses.has(course)) {
    selectedCourses.delete(course);
  } else {
    selectedCourses.add(course);
  }
  // Reset module selection when courses change
  selectedModules.clear();
  buildFilterPanel(allNotes);
  buildGraph(allNotes);
}

function toggleModule(module) {
  if (selectedModules.has(module)) {
    selectedModules.delete(module);
  } else {
    selectedModules.add(module);
  }
  refreshModuleChips(allNotes);
  // Update module chip states
  document.querySelectorAll('.module-chip').forEach(b => {
    b.classList.toggle('active', selectedModules.has(b.dataset.module));
  });
  buildGraph(allNotes);
}

function clearGraphFilter() {
  selectedCourses.clear();
  selectedModules.clear();
  buildFilterPanel(allNotes);
  buildGraph(allNotes);
}

function setGraphFilter(type, value, btn) {
  // Legacy single-select — kept for compatibility
  clearGraphFilter();
}

// ── main graph builder ────────────────────────────────────────────────────────

function updateGraph(notes) {
  const container = document.getElementById('graph-container');
  if (!container.classList.contains('active')) return;
  allNotes = notes;
  initCanvas();
  buildFilterPanel(notes);
  buildGraph(notes);
}

function buildGraph(notes) {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cx = W / 2, cy = H / 2;

  // Apply multi-select filter
  let filtered = notes;
  if (selectedCourses.size > 0) filtered = filtered.filter(n => selectedCourses.has(n.course_name));
  if (selectedModules.size > 0) filtered = filtered.filter(n => selectedModules.has(n.module_name));

  courseList = [...new Set(notes.map(n => n.course_name).filter(Boolean))];
  courseColorMap = {};

  // Preserve existing positions
  const posById = {};
  graphNodes.forEach(n => posById[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy });

  // Build note nodes
  const noteNodes = filtered.map(note => {
    const p = posById[note.note_id] || { x: cx + (Math.random()-0.5)*W*0.5, y: cy + (Math.random()-0.5)*H*0.5, vx:0, vy:0 };
    return {
      id: note.note_id, noteId: note.note_id, isWiki: false,
      label: (note.title || 'Untitled').substring(0, 28),
      course: note.course_name || '', module: note.module_name || '',
      status: note.status, wikilinks: note.wikilinks || [],
      x: p.x, y: p.y, vx: p.vx, vy: p.vy, r: 18,
    };
  });

  // Build wikilink nodes (deduplicated across filtered notes)
  const wikiMap = new Map(); // label → node
  noteNodes.forEach(nn => {
    (nn.wikilinks || []).forEach(wl => {
      if (!wikiMap.has(wl)) {
        const p = posById['wiki:' + wl] || { x: cx + (Math.random()-0.5)*W*0.6, y: cy + (Math.random()-0.5)*H*0.6, vx:0, vy:0 };
        wikiMap.set(wl, { id: 'wiki:' + wl, isWiki: true, label: wl, noteCount: 0, x: p.x, y: p.y, vx: p.vx, vy: p.vy, r: 7 });
      }
      wikiMap.get(wl).noteCount++;
    });
  });

  const wikiNodes = [...wikiMap.values()];
  // Scale wiki node size by how many notes reference it (more refs = bigger)
  wikiNodes.forEach(w => { w.r = Math.min(6 + w.noteCount * 2, 14); });

  graphNodes = [...noteNodes, ...wikiNodes];

  // Build edges: note→wikilink
  graphEdges = [];
  const nodeIndexById = {};
  graphNodes.forEach((n, i) => nodeIndexById[n.id] = i);

  noteNodes.forEach(nn => {
    (nn.wikilinks || []).forEach(wl => {
      const wi = nodeIndexById['wiki:' + wl];
      const ni = nodeIndexById[nn.id];
      if (wi !== undefined) graphEdges.push({ s: ni, t: wi });
    });
  });

  startSimulation();
}

// ── physics ───────────────────────────────────────────────────────────────────

function startSimulation() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  let ticks = 0;

  function tick() {
    const canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const cx = W / 2, cy = H / 2;
    const N = graphNodes;
    const { REPULSION, SPRING_LEN, SPRING_K, GRAVITY, DAMPING } = PHYSICS;

    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        const dx = N[j].x - N[i].x, dy = N[j].y - N[i].y;
        const dist = Math.max(Math.hypot(dx, dy), 1);
        const rep = (N[i].isWiki && N[j].isWiki) ? REPULSION * 0.3 : REPULSION;
        const force = rep / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        N[i].vx -= fx; N[i].vy -= fy;
        N[j].vx += fx; N[j].vy += fy;
      }
    }

    for (const { s, t: ti } of graphEdges) {
      const dx = N[ti].x - N[s].x, dy = N[ti].y - N[s].y;
      const dist = Math.max(Math.hypot(dx, dy), 1);
      const spring = SPRING_LEN * (N[s].isWiki || N[ti].isWiki ? 0.7 : 1);
      const force = SPRING_K * (dist - spring);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      N[s].vx += fx; N[s].vy += fy;
      N[ti].vx -= fx; N[ti].vy -= fy;
    }

    let ke = 0;
    for (const node of N) {
      if (node === dragNode) continue;
      node.vx += (cx - node.x) * GRAVITY;
      node.vy += (cy - node.y) * GRAVITY;
      node.vx *= DAMPING; node.vy *= DAMPING;
      node.x += node.vx; node.y += node.vy;
      node.x = Math.max(node.r + 24, Math.min(W - node.r - 24, node.x));
      node.y = Math.max(node.r + 24, Math.min(H - node.r - 24, node.y));
      ke += node.vx * node.vx + node.vy * node.vy;
    }

    renderGraph();
    ticks++;
    if (ke > 0.2 || ticks < 400 || dragNode) animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

// ── render ────────────────────────────────────────────────────────────────────

function renderGraph() {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const dark = isDark();
  const t = Date.now();

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = dark ? '#1c1712' : '#fdf6f0';
  ctx.fillRect(0, 0, W, H);

  // Edges
  for (const { s, t: ti } of graphEdges) {
    const a = graphNodes[s], b = graphNodes[ti];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = dark ? 'rgba(164,130,110,0.18)' : 'rgba(180,130,110,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Note nodes
  for (const node of graphNodes) {
    if (node.isWiki) continue;
    const color = getCourseColor(node.course || 'default');
    let alpha = node.status === 'rejected' ? 0.3
              : node.status === 'processing' ? 0.5 + 0.4 * Math.sin(t / 400)
              : 1;
    ctx.globalAlpha = alpha;

    if (node.status === 'in_review') {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (node.status === 'approved') {
      ctx.strokeStyle = dark ? '#2a9d6e' : '#2a9d6e';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Label
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = dark ? '#f5ede6' : '#1c1410';
    ctx.font = '500 10px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(node.label, node.x, node.y + node.r + 14);
    ctx.globalAlpha = 1;
  }

  // Wikilink nodes — diamond shape for clear visual distinction from circular note nodes
  for (const node of graphNodes) {
    if (!node.isWiki) continue;
    const wc = dark ? WIKI_COLOR_DARK : WIKI_COLOR_LIGHT;
    ctx.globalAlpha = 0.92;

    // Draw diamond (rotated square)
    const s = node.r * 1.25; // half-size of diamond
    ctx.beginPath();
    ctx.moveTo(node.x,     node.y - s); // top
    ctx.lineTo(node.x + s, node.y);     // right
    ctx.lineTo(node.x,     node.y + s); // bottom
    ctx.lineTo(node.x - s, node.y);     // left
    ctx.closePath();
    ctx.fillStyle = dark ? 'rgba(157,125,232,0.32)' : 'rgba(124,92,191,0.18)';
    ctx.fill();
    ctx.strokeStyle = wc;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Label
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = wc;
    ctx.font = '500 9px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    const shortLabel = node.label.length > 18 ? node.label.slice(0, 16) + '…' : node.label;
    ctx.fillText(shortLabel, node.x, node.y + s + 13);
    ctx.globalAlpha = 1;
  }

  ctx.textAlign = 'left';
}
