// BedDoc dashboard — polls /api/status, draws zones, drives alerts and the AI panel
// ── Constants ──────────────────────────────────────────────────────
const NATIVE_W = 1280, NATIVE_H = 400;
const ZONE_HEX = {green:'#22c55e',blue:'#38bdf8',orange:'#fb923c',
  purple:'#c084fc',yellow:'#fbbf24',red:'#f87171'};
const STATE_CLASS = {
  'ON BED':'s-on-bed','AT EDGE':'s-at-edge',
  'GETTING OUT':'s-getting-out','OFF BED':'s-off-bed',
};
const STATE_ORDER = ['ON BED','AT EDGE','GETTING OUT','OFF BED'];
const STATE_ICON = {'ON BED':'🛏️','AT EDGE':'⚠️','GETTING OUT':'🚶','OFF BED':'🚨'};
const VERDICT_LABEL = {CONFIRMED:'⚠ Confirmed exit', FALSE_ALARM:'✓ False alarm', UNCERTAIN:'? Uncertain'};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── State ──────────────────────────────────────────────────────────
let drawTarget    = null;   // null | 'bed' | 'edge'
let drawPoints    = [];     // native video coords
let drawClosed    = false;
let drawHover     = null;   // canvas coords for cursor preview
let editingZoneId = null;   // zone being edited (null = new)
let zonesData     = [];
let popupShown = false, lastState = '', lastLevel = -1;
let durBaseMs = 0, durPollAt = 0;
let audioCtx = null;

// ── Clock ──────────────────────────────────────────────────────────
function tickClock() {
  document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 5);
}
setInterval(tickClock, 10000); tickClock();

// ── Canvas ─────────────────────────────────────────────────────────
const canvas = document.getElementById('roiCanvas');
const ctx    = canvas.getContext('2d');
const wrap   = document.getElementById('videoWrap');
const img    = document.getElementById('videoFeed');

function syncCanvas() {
  canvas.width  = img.offsetWidth  || wrap.offsetWidth;
  canvas.height = img.offsetHeight || wrap.offsetHeight;
  redraw();
}
new ResizeObserver(syncCanvas).observe(wrap);
img.onload = syncCanvas;

function videoRect() {
  const el = document.getElementById('videoFeed');
  const rect = el.getBoundingClientRect();
  const natW = el.naturalWidth  || NATIVE_W;
  const natH = el.naturalHeight || NATIVE_H;
  const elAspect  = rect.width / rect.height;
  const vidAspect = natW / natH;
  let rendW, rendH, offX, offY;
  if (elAspect > vidAspect) {
    rendH = rect.height; rendW = rendH * vidAspect;
    offX  = (rect.width - rendW) / 2; offY = 0;
  } else {
    rendW = rect.width; rendH = rendW / vidAspect;
    offX  = 0; offY  = (rect.height - rendH) / 2;
  }
  return { rect, natW, natH, offX, offY, scaleX: natW / rendW, scaleY: natH / rendH };
}

function canvasToVideo(cx, cy) {
  const v = videoRect();
  const vx = Math.round((cx - v.rect.left - v.offX) * v.scaleX);
  const vy = Math.round((cy - v.rect.top  - v.offY) * v.scaleY);
  return { x: Math.max(0, Math.min(v.natW, vx)), y: Math.max(0, Math.min(v.natH, vy)) };
}

function videoToCanvas(p) {
  const v = videoRect();
  return { x: p.x / v.scaleX + v.offX, y: p.y / v.scaleY + v.offY };
}

// ── Draw mode ──────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!drawTarget || !drawPoints.length) return;

  const col  = drawTarget === 'edge' ? '#f59e0b' : '#22c55e';
  const cpts = drawPoints.map(videoToCanvas);
  const last = drawHover && !drawClosed ? [...cpts, drawHover] : cpts;

  if (last.length >= 3) {
    ctx.beginPath();
    last.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = col + (drawClosed ? '22' : '0e');
    ctx.fill();
  }

  ctx.beginPath();
  last.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  if (drawClosed) ctx.closePath();
  ctx.strokeStyle = col;
  ctx.lineWidth   = drawClosed ? 2 : 1.5;
  ctx.setLineDash(drawClosed ? [] : [5, 4]);
  ctx.shadowColor = col;
  ctx.shadowBlur  = drawClosed ? 10 : 4;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  cpts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = i === 0 ? 14 : 8;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px Inter,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, p.x, p.y);
  });

  if (!drawClosed && cpts.length >= 4 && drawHover) {
    const d = Math.hypot(drawHover.x - cpts[0].x, drawHover.y - cpts[0].y);
    if (d < 22) {
      ctx.beginPath(); ctx.arc(cpts[0].x, cpts[0].y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function updateDrawHint() {
  const hint = document.getElementById('drawHintText');
  const save = document.getElementById('saveDrawBtn');
  const label = drawTarget === 'edge' ? 'edge' : 'bed';
  if (!drawPoints.length) {
    hint.textContent = `Draw the ${label} zone — click on the video to place corners`;
    save.disabled = true;
  } else if (drawPoints.length < 4) {
    hint.textContent = `${drawPoints.length} point${drawPoints.length > 1 ? 's' : ''} — need at least 4`;
    save.disabled = true;
  } else if (!drawClosed) {
    hint.textContent = `${drawPoints.length} points — click the first point to close`;
    save.disabled = true;
  } else {
    hint.textContent = `${label[0].toUpperCase() + label.slice(1)} zone closed — click Save`;
    save.disabled = false;
  }
}

function startDraw(target, preloadPoints) {
  drawTarget = target;
  drawPoints = preloadPoints ? preloadPoints.map(p => ({...p})) : [];
  drawClosed = !!(preloadPoints && preloadPoints.length >= 4);
  drawHover  = null;
  document.getElementById('drawButtons').style.display  = 'none';
  document.getElementById('drawControls').style.display = 'flex';
  canvas.style.cursor = 'crosshair';
  updateDrawHint();
  redraw();
}

function cancelDraw() {
  drawTarget = null; drawPoints = []; drawClosed = false; drawHover = null;
  editingZoneId = null;
  document.getElementById('drawControls').style.display = 'none';
  document.getElementById('drawButtons').style.display  = 'flex';
  canvas.style.cursor = 'default';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function undoDraw() {
  if (drawClosed) { drawClosed = false; }
  else if (drawPoints.length) { drawPoints.pop(); }
  drawHover = null;
  updateDrawHint(); redraw();
}

function saveDrawing() {
  if (!drawClosed || drawPoints.length < 4) return;
  const poly  = drawPoints.map(p => ({x: p.x, y: p.y}));
  const label = document.getElementById('zoneName').value.trim() || 'Bed 1';
  const autoAdvanceToEdge = !editingZoneId && drawTarget === 'bed';
  let zones;
  if (editingZoneId) {
    zones = zonesData.map(z => {
      if (z.id !== editingZoneId) return z;
      if (drawTarget === 'bed') return { ...z, polygon: poly };
      return { ...z, edge_polygon: poly, edge_manual: true };
    });
  } else if (drawTarget === 'bed') {
    const id = 'zone_' + Date.now();
    zones = [...zonesData, { id, label, color: 'green', type: 'bed', polygon: poly }];
  } else {
    const last = zonesData[zonesData.length - 1];
    if (!last) { showToast('Draw a bed zone first', 'error'); return; }
    zones = zonesData.map(z => z.id === last.id
      ? { ...z, edge_polygon: poly, edge_manual: true } : z);
  }
  fetch('/api/zones', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ zones }) })
  .then(r => r.json())
  .then(d => {
    if (!d.ok) { showToast('Error: ' + (d.error || 'unknown'), 'error'); return; }
    if (autoAdvanceToEdge) {
      // Auto-start edge draw — nurse draws it next without extra clicks
      drawTarget = 'edge'; drawPoints = []; drawClosed = false; drawHover = null;
      editingZoneId = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      document.getElementById('saveDrawBtn').disabled = true;
      document.getElementById('drawHintText').textContent =
        'Bed zone saved. Now draw the EDGE zone (danger area around the bed)';
      redraw();
    } else {
      showToast('Zone saved', 'success');
      cancelDraw();
    }
  });
}

function editZone(zoneId, target) {
  const zone = zonesData.find(z => z.id === zoneId);
  if (!zone) { showToast('Zone not found', 'error'); return; }
  const poly = target === 'edge' ? (zone.edge_polygon || []) : (zone.polygon || []);
  editingZoneId = zoneId;
  startDraw(target, poly.length >= 3 ? poly : undefined);
}

canvas.addEventListener('mousemove', e => {
  if (!drawTarget || drawClosed) return;
  const r = canvas.getBoundingClientRect();
  drawHover = { x: e.clientX - r.left, y: e.clientY - r.top };
  redraw();
});

canvas.addEventListener('mouseleave', () => {
  drawHover = null;
  if (drawTarget) redraw();
});

canvas.addEventListener('click', e => {
  if (!drawTarget || drawClosed) return;
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  if (drawPoints.length >= 4) {
    const first = videoToCanvas(drawPoints[0]);
    if (Math.hypot(cx - first.x, cy - first.y) < 20) {
      drawClosed = true; drawHover = null;
      updateDrawHint(); redraw(); return;
    }
  }
  drawPoints.push(canvasToVideo(e.clientX, e.clientY));
  updateDrawHint(); redraw();
});

document.getElementById('undoDrawBtn').onclick  = undoDraw;
document.getElementById('cancelDrawBtn').onclick = cancelDraw;
document.getElementById('saveDrawBtn').onclick   = saveDrawing;

// ── Zones ──────────────────────────────────────────────────────────
let lastZonesKey = '';
function renderZones(zones) {
  const key = JSON.stringify(zones.map(z => [z.id, z.label, z.color, z.type]));
  if (key === lastZonesKey) return;          // avoid re-rendering buttons every second
  lastZonesKey = key;
  const el = document.getElementById('zoneList');
  document.getElementById('zoneCount').textContent = zones.length + (zones.length === 1 ? ' zone' : ' zones');
  if (!zones.length) { el.innerHTML = '<div class="empty">No zones · draw a bed zone to begin</div>'; return; }
  el.innerHTML = zones.map(z => {
    const hex = ZONE_HEX[z.color] || '#22c55e';
    return `<div class="zone-row">
      <div class="zdot" style="background:${hex}"></div>
      <span class="zname">${esc(z.label)}</span>
      <button class="btn btn-sm" onclick="editZone('${esc(z.id)}','bed')">Edit bed</button>
      <button class="btn btn-sm" onclick="editZone('${esc(z.id)}','edge')">Edit edge</button>
      <button class="btn btn-sm btn-danger" onclick="deleteZone('${esc(z.id)}')" title="Delete zone">✕</button>
    </div>`;
  }).join('');
}

function deleteZone(id) {
  if (!confirm('Delete this zone?')) return;
  fetch('/api/zones/' + id, { method:'DELETE' })
    .then(r => r.json())
    .then(d => d.ok && showToast('Zone deleted', 'success'));
}

// ── Event log ──────────────────────────────────────────────────────
let lastLogKey = '';
function renderLog(log) {
  const key = log.length + '|' + (log[0] ? log[0].time + log[0].new_state : '');
  if (key === lastLogKey) return;
  lastLogKey = key;
  document.getElementById('logCount').textContent = log.length + ' events';
  const el = document.getElementById('logList');
  if (!log.length) { el.innerHTML = '<div class="lempty">Waiting for events…</div>'; return; }
  el.innerHTML = log.map(e => `
    <div class="lrow">
      <div class="lpip ${esc((e.level_name||'none').toLowerCase())}"></div>
      <div class="lmsg">${e.prev_state
        ? esc(e.prev_state) + '<span class="arrow">→</span><b>' + esc(e.new_state) + '</b>'
        : esc(e.message || e.new_state || '')}</div>
      <div class="lts num">${esc((e.time || '').slice(11))}</div>
    </div>`).join('');
}

// ── Debug panel ────────────────────────────────────────────────────
function boolHtml(v) {
  if (v === undefined || v === null) return '—';
  return v ? '<span class="t">✓</span>' : '<span class="f">✗</span>';
}

function renderDebug(data) {
  const dbg = data.debug || {};
  const ar  = dbg.ar !== undefined ? dbg.ar.toFixed(2) : '—';
  const mot = data.motion_score !== undefined ? Math.round(data.motion_score / 1000) + 'k' : '—';
  document.getElementById('debugSummary').textContent = `AR ${ar} · MOT ${mot}`;

  const arEl = document.getElementById('dbAr');
  arEl.textContent = ar;
  arEl.className   = 'dbval' + (dbg.lying_flat ? ' flat' : '');

  document.getElementById('dbFlat').innerHTML   = boolHtml(dbg.lying_flat);
  document.getElementById('dbMot').textContent  = mot;
  document.getElementById('dbCand').textContent = dbg.candidate || '—';

  document.getElementById('dbGraceEl').textContent =
    dbg.grace_elapsed !== undefined ? dbg.grace_elapsed.toFixed(1) + 's' : '—';
  document.getElementById('dbGraceNd').textContent =
    dbg.grace_needed  !== undefined ? dbg.grace_needed + 's' : '—';

  document.getElementById('dbTorsoBed').innerHTML  = boolHtml(dbg.torso_in_bed);
  document.getElementById('dbHeadBed').innerHTML   = boolHtml(dbg.head_in_bed);
  document.getElementById('dbTorsoEdge').innerHTML = boolHtml(dbg.torso_in_edge);
  document.getElementById('dbHeadEdge').innerHTML  = boolHtml(dbg.head_in_edge);
  document.getElementById('dbTorsoNear').innerHTML = boolHtml(dbg.torso_in_near);
  document.getElementById('dbHeadNear').innerHTML  = boolHtml(dbg.head_in_near);
}

// ── Status hero ────────────────────────────────────────────────────
function updateBadge(pstate, level, lastTs) {
  document.getElementById('hero').className = 'hero ' + (STATE_CLASS[pstate] || 's-on-bed');
  document.getElementById('heroIcon').textContent  = STATE_ICON[pstate] || '🛏️';
  document.getElementById('heroState').textContent = pstate;
  if (lastTs) document.getElementById('heroTs').textContent = lastTs.slice(11) || lastTs;
  const idx = STATE_ORDER.indexOf(pstate);
  document.querySelectorAll('#steps .step').forEach((s, i) => {
    s.className = 'step' + (i < idx ? ' done' : i === idx ? ' cur' : '');
  });
  document.title = (level >= 2 ? '⚠ ' + pstate + ' · ' : '') + 'BedDoc';
}

// ── Duration counter (smooth 200 ms tick) ─────────────────────────
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}
setInterval(() => {
  if (!durPollAt) return;
  document.getElementById('heroDur').textContent =
    fmtDur(durBaseMs + (Date.now() - durPollAt));
}, 200);

// ── Web Audio ──────────────────────────────────────────────────────
function playBeep(level) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioCtx;
    const tone = (freq, t0, dur) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.22, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0); o.stop(t0 + dur);
    };
    if (level >= 4) {
      // OFF BED — siren pattern ×3
      [0, 0.38, 0.76].forEach(t => {
        tone(900, ac.currentTime + t,        0.22);
        tone(650, ac.currentTime + t + 0.22, 0.22);
      });
    } else if (level === 3) {
      // GETTING OUT — triple pulse
      [0, 0.27, 0.54].forEach(t => tone(780, ac.currentTime + t, 0.2));
    } else {
      // AT EDGE — single beep
      tone(660, ac.currentTime, 0.5);
    }
  } catch (e) {}
}

// ── Alert popup ────────────────────────────────────────────────────
function triggerAlert(level, msg) {
  if (level < 2) return;
  const p = document.getElementById('alertPopup');
  document.getElementById('apLv').textContent  =
    level >= 4 ? '🚨 CRITICAL' : level >= 3 ? '🚨 ALERT' : '⚠️ WARNING';
  document.getElementById('apMsg').textContent = msg;
  p.className = level >= 3 ? 'show' : 'show warn';
  popupShown = true;
  playBeep(level);
}
function ackAndClose() {
  fetch('/api/acknowledge', { method:'POST' });
  document.getElementById('alertPopup').classList.remove('show');
  popupShown = false;
  showToast('Alert acknowledged', 'success');
}
function acknowledge() {
  fetch('/api/acknowledge', { method:'POST' });
  document.getElementById('alertPopup').classList.remove('show');
  showToast('Alert acknowledged', 'success');
}

// ── Toast ──────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, type = '') {
  toastEl.textContent = msg; toastEl.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3000);
}

// ── Header chips ───────────────────────────────────────────────────
function renderHeader(d) {
  document.getElementById('fpsVal').textContent = d.fps || '—';
  const ok = d.cam_status === 'OK';
  document.getElementById('camVal').textContent = ok ? 'OK' : (d.cam_status || '—');
  document.getElementById('camDot').className = 'dot ' + (ok ? 'ok' : 'crit');
}

// ── AI verification ────────────────────────────────────────────────
function relTime(ts) {
  if (!ts) return '';
  const t = new Date(ts.replace(' ', 'T'));
  const s = Math.round((Date.now() - t) / 1000);
  if (isNaN(s)) return ts;
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return ts.slice(11, 16);
}

function renderVerdict(v, pstate) {
  // Hero strip: only while the state the agent judged is still current
  const hv = document.getElementById('heroVerdict');
  if (v && v.for_state === pstate) {
    hv.className = 'verdict v-' + v.verdict.toLowerCase();
    hv.style.display = 'flex';
    document.getElementById('hvTag').textContent    = '🧠 AI · ' + (VERDICT_LABEL[v.verdict] || v.verdict);
    document.getElementById('hvReason').textContent = v.reason || '';
    document.getElementById('hvTime').textContent   = relTime(v.time);
  } else {
    hv.style.display = 'none';
  }
  // AI card: always the latest verdict
  const box = document.getElementById('aiVerdict');
  if (!v) return;
  box.className = 'ai-verdict v-' + v.verdict.toLowerCase();
  document.getElementById('aiBig').textContent  = VERDICT_LABEL[v.verdict] || v.verdict;
  document.getElementById('aiWhy').textContent  = v.reason || '';
  document.getElementById('aiWhen').textContent = `For ${v.for_state} · ${relTime(v.time)}`;
}

const RUN_ICON = {running:'⏳', completed:'✅', error:'⚠️', timeout:'⌛', cancelled:'⏹'};
function renderAgent(a) {
  const on = a && a.enabled;
  document.getElementById('aiBody').style.display = on ? '' : 'none';
  document.getElementById('aiOff').style.display  = on ? 'none' : '';
  const tag = document.getElementById('aiStatus');
  const dot = document.getElementById('aiDot');
  const val = document.getElementById('aiVal');
  if (!on) {
    tag.textContent = 'Off'; tag.className = 'status-tag';
    dot.className = 'dot'; val.textContent = 'off';
    return;
  }
  const runs = a.runs || [];
  const lastErr = runs[0] && runs[0].status === 'error';
  if (a.busy) {
    tag.textContent = 'Checking…'; tag.className = 'status-tag running';
    dot.className = 'dot busy'; val.textContent = 'checking';
  } else if (lastErr) {
    tag.textContent = 'Last run failed'; tag.className = 'status-tag error';
    dot.className = 'dot crit'; val.textContent = 'error';
  } else {
    tag.textContent = 'Ready'; tag.className = 'status-tag ready';
    dot.className = 'dot ai'; val.textContent = 'ready';
  }
  document.getElementById('aiRunBtn').disabled = a.busy;
  document.getElementById('aiRunBtn').textContent = a.busy ? 'Checking…' : 'Check now';

  const el = document.getElementById('aiRuns');
  if (!runs.length) { el.innerHTML = '<div class="empty">No runs yet</div>'; return; }
  // Full error text only on the newest run; older failures just say "failed"
  el.innerHTML = runs.slice(0, 5).map((r, i) => `
    <div class="run">
      <div class="run-ic">${RUN_ICON[r.status] || '•'}</div>
      <div class="run-body">
        <div class="run-trig">${esc(r.trigger)}</div>
        ${r.status === 'error' || r.status === 'timeout'
          ? `<div class="run-msg">${esc(i === 0 ? (r.message || r.status) : r.status === 'timeout' ? 'Timed out' : 'Failed')}</div>` : ''}
      </div>
      <div class="run-time num">${esc(relTime(r.time))}</div>
    </div>`).join('');
}

function runAgentNow() {
  fetch('/api/agent/run', { method:'POST' })
    .then(r => r.json())
    .then(d => d.ok ? showToast('AI check started', 'success')
                    : showToast(d.error || 'Could not start AI check', 'error'))
    .catch(() => showToast('Could not start AI check', 'error'));
}

// ── Poll ───────────────────────────────────────────────────────────
async function poll() {
  try {
    const d = await fetch('/api/status').then(r => r.json());

    renderHeader(d);
    zonesData = d.zones || [];
    renderZones(zonesData);

    const pstate = d.patient_state || 'UNKNOWN';
    const level  = d.alert_level   || 0;

    // Sync duration baseline
    durBaseMs = (d.state_duration_s || 0) * 1000;
    durPollAt = Date.now();

    if (pstate !== lastState || level !== lastLevel) {
      if (testRunning && pstate !== lastState) recordTestStateChange(pstate);
      lastState = pstate; lastLevel = level;
      const lastTs = d.log && d.log[0] ? d.log[0].time : '';
      updateBadge(pstate, level, lastTs);
      if (level >= 2 && !popupShown) triggerAlert(level, pstate);
      if (level < 2) popupShown = false;
    }

    renderVerdict(d.agent_verdict, pstate);
    renderAgent(d.agent);
    renderDebug(d);
    if (d.log) renderLog(d.log);

  } catch (e) {
    document.getElementById('camVal').textContent = 'offline';
    document.getElementById('camDot').className = 'dot crit';
  }
}

setInterval(poll, 1000);
poll();

// ── Zone Settings slider ───────────────────────────────────────────
let zoneSettingsTimer = null;
const nearSlider = document.getElementById('nearSlider');

function postZoneSettings() {
  fetch('/api/zone-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ near_offset: +nearSlider.value })
  })
  .then(r => r.json())
  .then(d => d.ok && showToast('Near zone offset updated', 'success'));
}

nearSlider.addEventListener('input', () => {
  document.getElementById('nearVal').textContent = nearSlider.value;
  clearTimeout(zoneSettingsTimer);
  zoneSettingsTimer = setTimeout(postZoneSettings, 400);
});

// ── Test Mode ──────────────────────────────────────────────────────
let testRunning    = false;
let testStartTime  = 0;
let testSnapshots  = [];
let testStateLog   = [];   // [{state, timeMs, dur}]
let testLastState  = null;
let testLastTs     = 0;
let testPollTimer  = null;
let testElapsedTimer = null;

function toggleTest() {
  testRunning ? stopTest() : startTest();
}

async function startTest() {
  await fetch('/api/test-mode', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ active: true }) });
  testRunning   = true;
  testStartTime = Date.now();
  testSnapshots = [];
  testStateLog  = [{ state: lastState, timeMs: Date.now(), dur: -1 }];
  testLastState = lastState;
  testLastTs    = Date.now();
  document.getElementById('testReport').style.display = 'none';
  document.getElementById('testStatus').style.display = 'block';
  document.getElementById('testElapsed').textContent  = '0s';
  document.getElementById('testSumm').textContent     = '● recording';
  const btn = document.getElementById('testBtn');
  btn.textContent = '■ Stop test';
  btn.className   = 'btn btn-block btn-danger';
  showToast('Test started', 'success');
  testPollTimer    = setInterval(fetchTestSnapshots, 2000);
  testElapsedTimer = setInterval(() => {
    document.getElementById('testElapsed').textContent =
      Math.round((Date.now() - testStartTime) / 1000) + 's';
  }, 1000);
}

async function fetchTestSnapshots() {
  const d = await fetch('/api/test-log').then(r => r.json()).catch(() => ({log:[]}));
  testSnapshots = d.log || [];
}

async function stopTest() {
  clearInterval(testPollTimer);
  clearInterval(testElapsedTimer);
  await fetch('/api/test-mode', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ active: false }) });
  testRunning = false;
  document.getElementById('testStatus').style.display = 'none';
  document.getElementById('testSumm').textContent     = '';
  const btn = document.getElementById('testBtn');
  btn.textContent = '▶ Start test';
  btn.className   = 'btn btn-block';
  // Final snapshot fetch then render
  const d = await fetch('/api/test-log').then(r => r.json()).catch(() => ({log:[]}));
  testSnapshots = d.log || [];
  // Finalize last state entry duration
  if (testStateLog.length > 0)
    testStateLog[testStateLog.length - 1].dur = Math.round((Date.now() - testLastTs) / 1000);
  renderTestReport();
}

function recordTestStateChange(newState) {
  const now = Date.now();
  if (testStateLog.length > 0)
    testStateLog[testStateLog.length - 1].dur = Math.round((now - testLastTs) / 1000);
  testStateLog.push({ state: newState, timeMs: now, dur: -1 });
  testLastState = newState;
  testLastTs    = now;
}

function buildReportText() {
  const totalS = Math.round((Date.now() - testStartTime) / 1000);
  const total  = testSnapshots.length;

  // 1. Timeline
  const tlLines = testStateLog.map(e => {
    const t   = new Date(e.timeMs).toTimeString().slice(0, 8);
    const dur = e.dur >= 0 ? `(lasted ${e.dur}s)` : '(ongoing)';
    return `  ${t}  ${e.state.padEnd(13)} ${dur}`;
  });

  // 2. Detection stats
  const detected   = testSnapshots.filter(s => s.debug && s.debug.candidate).length;
  const graceSnaps = testSnapshots.filter(s => s.debug && (s.debug.grace_elapsed || 0) > 0);
  const arVals     = testSnapshots.map(s => s.debug && s.debug.ar).filter(v => v != null);
  const arMin      = arVals.length ? Math.min(...arVals).toFixed(2) : '—';
  const arMax      = arVals.length ? Math.max(...arVals).toFixed(2) : '—';
  const flatCount  = testSnapshots.filter(s => s.debug && s.debug.lying_flat).length;

  // 3. Grace events
  const graceLines = graceSnaps.map(s =>
    `  ${s.t}  elapsed=${s.debug.grace_elapsed}s  needed=${s.debug.grace_needed || '?'}s`);

  // 4. Anomalies: state flickers < 3s
  const flickers = testStateLog.filter(e => e.dur >= 0 && e.dur < 3);
  const flickerLines = flickers.map(e => {
    const t = new Date(e.timeMs).toTimeString().slice(0, 8);
    return `  ${t}  ${e.state} lasted only ${e.dur}s ← flicker`;
  });

  return [
    `=== BedDoc Test Report ===`,
    `Duration: ${totalS}s  |  Snapshots: ${total}  |  State transitions: ${testStateLog.length}`,
    ``,
    `── State Timeline ──`,
    ...(tlLines.length ? tlLines : ['  (no changes recorded)']),
    ``,
    `── Detection Stats ──`,
    `  Person visible:   ${detected} / ${total} snapshots`,
    `  Person not found: ${total - detected} / ${total} snapshots`,
    `  AR range:         ${arMin} – ${arMax}`,
    `  Lying flat:       ${flatCount} snapshots`,
    ``,
    `── Grace Timer Events (${graceSnaps.length} snapshots) ──`,
    ...(graceLines.length ? graceLines : ['  (none)']),
    ``,
    `── Anomalies (flickers < 3s) ──`,
    ...(flickerLines.length ? flickerLines : ['  (none)']),
  ].join('\n');
}

function renderTestReport() {
  const text = buildReportText();
  window._testReportText = text;
  document.getElementById('testReportPre').textContent = text;
  document.getElementById('testReport').style.display = 'block';
}

function copyReport() {
  navigator.clipboard.writeText(window._testReportText || '')
    .then(() => showToast('Report copied', 'success'))
    .catch(() => showToast('Copy failed — select text manually', 'error'));
}
