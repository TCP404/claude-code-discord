/**
 * Admin SPA — single HTML template with inline CSS and vanilla JS.
 */

export const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Admin</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; padding: 24px; }
h1 { font-size: 1.5rem; margin-bottom: 16px; color: #7289da; }
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 2px solid #2d2d44; }
.tab { padding: 10px 20px; cursor: pointer; border: none; background: transparent; color: #888; font-size: 0.9rem; border-bottom: 2px solid transparent; margin-bottom: -2px; }
.tab.active { color: #7289da; border-bottom-color: #7289da; }
.tab:hover { color: #aaa; }
.panel { display: none; }
.panel.active { display: block; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #2d2d44; font-size: 0.85rem; }
th { color: #7289da; font-weight: 600; }
tr:hover { background: #2d2d44; }
.btn { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
.btn-primary { background: #7289da; color: #fff; }
.btn-primary:hover { background: #5b6eae; }
.btn-danger { background: #ed4245; color: #fff; }
.btn-danger:hover { background: #c73b3e; }
.btn-sm { padding: 4px 10px; font-size: 0.75rem; }
.form-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.form-row input, .form-row select { padding: 8px 12px; border: 1px solid #3d3d5c; border-radius: 4px; background: #16213e; color: #e0e0e0; font-size: 0.85rem; }
.form-row input { flex: 1; min-width: 120px; }
.form-row select { min-width: 180px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.stat-card { background: #16213e; border-radius: 8px; padding: 16px; }
.stat-card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
.stat-card .value { font-size: 1.3rem; margin-top: 4px; color: #fff; }
.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; background: #2d5a27; color: #7dff6e; }
.empty { color: #666; font-style: italic; padding: 20px 0; }
.toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 6px; background: #2d5a27; color: #7dff6e; font-size: 0.85rem; display: none; z-index: 100; }
.toast.error { background: #5a2727; color: #ff6e6e; }
.switch { position: relative; display: inline-block; width: 38px; height: 20px; vertical-align: middle; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; inset: 0; background-color: #3d3d5c; transition: .2s; border-radius: 20px; }
.slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; top: 3px; background-color: #e0e0e0; transition: .2s; border-radius: 50%; }
input:checked + .slider { background-color: #7289da; }
input:checked + .slider:before { transform: translateX(18px); }
.ws-group { margin-top: 18px; }
.ws-group:first-child { margin-top: 0; }
.ws-group-header { display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; background: #16213e; border-radius: 6px 6px 0 0; border-bottom: 1px solid #2d2d44; }
.ws-group-header .ws-name { font-weight: 600; color: #7289da; font-size: 0.9rem; }
.ws-group-header .ws-path { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; color: #888; }
.ws-group-header .ws-count { margin-left: auto; font-size: 0.75rem; color: #888; }
.ws-group table { margin-top: 0; }
.ws-group table th:first-child, .ws-group table td:first-child { padding-left: 12px; }
</style>
</head>
<body>
<div class="container">
<h1>Bot Admin</h1>
<div class="tabs">
  <button class="tab active" data-tab="status">Status</button>
  <button class="tab" data-tab="workspaces">Workspaces</button>
  <button class="tab" data-tab="sessions">Sessions</button>
  <button class="tab" data-tab="schedules">Schedules</button>
</div>

<!-- Status Panel -->
<div id="status" class="panel active">
  <div class="stat-grid" id="stat-grid"></div>
</div>

<!-- Workspaces Panel -->
<div id="workspaces" class="panel">
  <div class="form-row">
    <input id="ws-name" placeholder="Name" />
    <input id="ws-path" placeholder="/absolute/path" />
    <button class="btn btn-primary" onclick="addWorkspace()">Add</button>
  </div>
  <table>
    <thead><tr><th>Name</th><th>Path</th><th>Channel</th><th>Auto-Thread</th><th></th></tr></thead>
    <tbody id="ws-tbody"></tbody>
  </table>
</div>

<!-- Sessions Panel -->
<div id="sessions" class="panel">
  <div id="hq-config" style="margin-bottom: 12px; padding: 8px 12px; background: #1e293b; border-radius: 6px; font-size: 13px; color: #94a3b8;"></div>
  <div style="margin-bottom: 12px;">
    <button class="btn" onclick="refreshSessions()">Refresh</button>
    <button class="btn btn-danger" onclick="cleanupSessions()">Cleanup (>72h)</button>
  </div>
  <div id="sess-groups"></div>
</div>

<!-- Schedules Panel -->
<div id="schedules" class="panel">
  <div style="margin-bottom: 16px; padding: 12px; background: #16213e; border-radius: 6px;">
    <div style="font-size: 0.85rem; color: #7289da; font-weight: 600; margin-bottom: 10px;">New Scheduled Task</div>
    <div class="form-row">
      <select id="sched-ws" style="min-width: 150px;"><option value="">Select workspace...</option></select>
      <input id="sched-cmd" placeholder="Command (e.g. /cs-review 昨天数据)" style="flex: 2;" />
    </div>
    <div class="form-row" style="margin-top: 8px;">
      <select id="sched-type" onchange="updateSchedForm()">
        <option value="daily">Daily</option>
        <option value="interval">Every N hours</option>
        <option value="weekly">Weekly</option>
      </select>
      <input id="sched-time" type="time" value="09:00" style="width: 120px;" />
      <input id="sched-interval" type="number" min="1" max="72" value="6" placeholder="Hours" style="width: 80px; display: none;" />
      <div id="sched-weekdays" style="display: none; align-items: center; gap: 4px; font-size: 0.8rem;">
        <label><input type="checkbox" value="1" checked> Mon</label>
        <label><input type="checkbox" value="2" checked> Tue</label>
        <label><input type="checkbox" value="3" checked> Wed</label>
        <label><input type="checkbox" value="4" checked> Thu</label>
        <label><input type="checkbox" value="5" checked> Fri</label>
        <label><input type="checkbox" value="6"> Sat</label>
        <label><input type="checkbox" value="0"> Sun</label>
      </div>
      <input id="sched-thread-name" placeholder="Thread name (optional)" style="flex: 1;" />
      <button class="btn btn-primary" onclick="addSchedule()">Add</button>
    </div>
  </div>
  <table>
    <thead><tr><th>Workspace</th><th>Command</th><th>Schedule</th><th>Enabled</th><th>Last Run</th><th></th></tr></thead>
    <tbody id="sched-tbody"></tbody>
  </table>
  <div id="sched-detail" style="margin-top: 16px; display: none; padding: 12px; background: #16213e; border-radius: 6px;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
      <span style="font-size: 0.85rem; color: #7289da; font-weight: 600;">Task Detail</span>
      <button class="btn btn-sm" onclick="hideSchedDetail()">Close</button>
    </div>
    <div id="sched-detail-body"></div>
  </div>
  <div id="sched-logs" style="margin-top: 16px; display: none;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
      <span style="font-size: 0.85rem; color: #7289da; font-weight: 600;">Run History</span>
      <button class="btn btn-sm" onclick="refreshSchedLogs()">Refresh</button>
      <button class="btn btn-sm" onclick="hideSchedLogs()">Close</button>
    </div>
    <table>
      <thead><tr><th>Time</th><th>Status</th><th>Thread</th></tr></thead>
      <tbody id="sched-logs-tbody"></tbody>
    </table>
  </div>
</div>

<div class="toast" id="toast"></div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let channels = [];

// Tabs
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('#' + tab.dataset.tab).classList.add('active');
  });
});

function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (error ? ' error' : '');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ─── Status ───
async function loadStatus() {
  const res = await fetch('/api/status');
  const d = await res.json();
  $('#stat-grid').innerHTML = \`
    <div class="stat-card"><div class="label">Bot</div><div class="value">\${d.botUser || 'N/A'} <span class="badge">online</span></div></div>
    <div class="stat-card"><div class="label">Uptime</div><div class="value">\${formatUptime(d.uptime)}</div></div>
    <div class="stat-card"><div class="label">Guild</div><div class="value">\${d.guild?.name || 'N/A'}</div></div>
    <div class="stat-card"><div class="label">Workspaces</div><div class="value">\${d.workspaceCount}</div></div>
    <div class="stat-card"><div class="label">Active Sessions</div><div class="value">\${d.sessionCount}</div></div>
    <div class="stat-card"><div class="label">Managed Channels</div><div class="value">\${d.managedChannels.length}</div></div>
  \`;
}

// ─── Channels ───
async function loadChannels() {
  const res = await fetch('/api/channels');
  channels = await res.json();
}

// ─── Workspaces ───
async function loadWorkspaces() {
  const res = await fetch('/api/workspaces');
  const list = await res.json();
  const tbody = $('#ws-tbody');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No workspaces configured</td></tr>'; return; }
  tbody.innerHTML = list.map(w => {
    const ch = channels.find(c => c.id === w.channelId);
    const chName = ch ? (ch.category ? ch.category + '/' : '') + ch.name : w.channelId;
    const checked = w.autoThread ? 'checked' : '';
    return \`<tr>
      <td>\${w.name}</td>
      <td class="mono">\${w.path}</td>
      <td>#\${chName}</td>
      <td><label class="switch"><input type="checkbox" \${checked} onchange="toggleAutoThread('\${w.name}', this.checked)"><span class="slider"></span></label></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteWorkspace('\${w.name}')">Delete</button></td>
    </tr>\`;
  }).join('');
}

async function toggleAutoThread(name, enabled) {
  const res = await fetch('/api/workspaces/' + encodeURIComponent(name), {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ autoThread: enabled })
  });
  const d = await res.json();
  if (!res.ok) { toast(d.error || 'Failed to toggle auto-thread', true); loadWorkspaces(); return; }
  toast('Auto-thread ' + (enabled ? 'enabled' : 'disabled') + ' for ' + name);
}

async function addWorkspace() {
  const name = $('#ws-name').value.trim();
  const path = $('#ws-path').value.trim();
  if (!name || !path) { toast('Name and path are required', true); return; }
  const res = await fetch('/api/workspaces', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, path })
  });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast('Workspace added — channel created');
  $('#ws-name').value = ''; $('#ws-path').value = '';
  loadChannels();
  loadWorkspaces();
}

async function deleteWorkspace(name) {
  if (!confirm('Delete workspace "' + name + '"?')) return;
  const res = await fetch('/api/workspaces/' + encodeURIComponent(name), { method: 'DELETE' });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast('Workspace deleted');
  loadWorkspaces();
}

// ─── Sessions ───
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadSessions() {
  const [res, statusRes] = await Promise.all([fetch('/api/sessions'), fetch('/api/status')]);
  const list = await res.json();
  const status = await statusRes.json();
  const hqCfg = status.hotQueryConfig;
  const hqEl = $('#hq-config');
  if (hqCfg) {
    const idleMin = Math.round(hqCfg.idleMs / 60000);
    hqEl.innerHTML = \`🔥 <strong>Hot Query</strong>: \${hqCfg.enabled ? '<span style="color:#4ade80">enabled</span>' : '<span style="color:#f87171">disabled</span>'} &nbsp;|&nbsp; max sessions: <strong>\${hqCfg.maxSessions}</strong> &nbsp;|&nbsp; idle timeout: <strong>\${idleMin}m</strong>\`;
  } else {
    hqEl.style.display = 'none';
  }
  const container = $('#sess-groups');
  if (!list.length) { container.innerHTML = '<div class="empty">No active sessions</div>'; return; }

  // Group by workspace (null → "Unassigned")
  const groups = new Map();
  for (const s of list) {
    const key = s.workspaceName || '__unassigned__';
    if (!groups.has(key)) {
      groups.set(key, {
        name: s.workspaceName,
        path: s.workspacePath,
        sessions: [],
      });
    }
    groups.get(key).sessions.push(s);
  }

  // Sort groups: named workspaces alphabetically, unassigned last
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    return a.localeCompare(b);
  });

  container.innerHTML = sortedKeys.map(key => {
    const g = groups.get(key);
    // Sort sessions by last activity (most recent first)
    g.sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    const headerName = g.name ? escapeHtml(g.name) : 'Unassigned';
    const headerPath = g.path ? '<span class="ws-path">' + escapeHtml(g.path) + '</span>' : '';
    const rows = g.sessions.map(s => {
      const hotChecked = s.hotQuery ? 'checked' : '';
      return \`<tr>
      <td>\${escapeHtml(s.threadName)}</td>
      <td class="mono">\${s.sessionId.substring(0, 8)}...</td>
      <td>\${timeAgo(s.createdAt)}</td>
      <td>\${timeAgo(s.lastActivity)}</td>
      <td>\${s.messageCount}</td>
      <td><label class="switch"><input type="checkbox" \${hotChecked} onchange="toggleHotQuery('\${s.sessionId}', this.checked)"><span class="slider"></span></label></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteSession('\${s.sessionId}')">Delete</button></td>
    </tr>\`;
    }).join('');
    return \`<div class="ws-group">
      <div class="ws-group-header">
        <span class="ws-name">\${headerName}</span>
        \${headerPath}
        <span class="ws-count">\${g.sessions.length} session\${g.sessions.length === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead><tr><th>Thread</th><th>Session ID</th><th>Created</th><th>Last Activity</th><th>Messages</th><th>🔥 Hot</th><th></th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    </div>\`;
  }).join('');
}

async function toggleHotQuery(sessionId, enabled) {
  const res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/hot-query', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast(enabled ? 'Hot query enabled' : 'Hot query disabled');
}

async function deleteSession(sessionId) {
  if (!confirm('Delete this session and its Discord thread?')) return;
  const res = await fetch('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast(d.threadDeleted ? 'Session and thread deleted' : 'Session removed (thread already gone)');
  loadSessions();
}

async function refreshSessions() {
  const res = await fetch('/api/sessions/refresh', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast('Refreshed: removed ' + d.removed + ' stale (of ' + d.total + ' total)');
  loadSessions();
}

async function cleanupSessions() {
  if (!confirm('Remove sessions older than 24 hours?')) return;
  const res = await fetch('/api/sessions/cleanup', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ maxAgeMs: 24 * 3600000 })
  });
  const d = await res.json();
  toast('Cleaned up ' + d.removed + ' sessions');
  loadSessions();
}

// ─── Schedules ───
function updateSchedForm() {
  const type = $('#sched-type').value;
  $('#sched-time').style.display = (type === 'daily' || type === 'weekly') ? '' : 'none';
  $('#sched-interval').style.display = type === 'interval' ? '' : 'none';
  $('#sched-weekdays').style.display = type === 'weekly' ? 'flex' : 'none';
}

function describeSchedule(s) {
  if (!s) return '—';
  if (s.type === 'daily') return 'Daily at ' + (s.time || '??:??');
  if (s.type === 'interval') return 'Every ' + s.intervalHours + 'h' + (s.time ? ' (start ' + s.time + ')' : '');
  if (s.type === 'weekly') {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const names = (s.weekdays || []).map(d => days[d]).join(',');
    return names + ' at ' + (s.time || '??:??');
  }
  return JSON.stringify(s);
}

async function loadSchedules() {
  const [res, wsRes] = await Promise.all([fetch('/api/schedules'), fetch('/api/workspaces')]);
  const list = await res.json();
  const workspaces = await wsRes.json();

  // Always populate workspace dropdown
  const sel = $('#sched-ws');
  sel.innerHTML = '<option value="">Select workspace...</option>' +
    workspaces.map(w => '<option value="' + escapeHtml(w.name) + '">' + escapeHtml(w.name) + '</option>').join('');

  const tbody = $('#sched-tbody');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No scheduled tasks</td></tr>'; return; }
  tbody.innerHTML = list.map(t => {
    const checked = t.enabled ? 'checked' : '';
    const lastRun = t.lastRunAt ? timeAgo(t.lastRunAt) + ' <span class="badge" style="' + (t.lastRunStatus === 'failed' ? 'background:#5a2727;color:#ff6e6e' : '') + '">' + (t.lastRunStatus || '—') + '</span>' : '—';
    return \`<tr>
      <td>\${escapeHtml(t.workspaceName)}</td>
      <td class="mono" style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="\${escapeHtml(t.command)}">\${escapeHtml(t.command)}</td>
      <td>\${describeSchedule(t.schedule)}</td>
      <td><label class="switch"><input type="checkbox" \${checked} onchange="toggleSchedule('\${t.id}', this.checked)"><span class="slider"></span></label></td>
      <td>\${lastRun}</td>
      <td>
        <button class="btn btn-sm" onclick="showSchedDetail('\${t.id}')" title="Details">⚙</button>
        <button class="btn btn-primary btn-sm" onclick="runSchedule('\${t.id}')" title="Run now">▶</button>
        <button class="btn btn-sm" onclick="showSchedLogs('\${t.id}')" title="Logs">📋</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSchedule('\${t.id}')">✕</button>
      </td>
    </tr>\`;
  }).join('');
}

async function addSchedule() {
  const workspaceName = $('#sched-ws').value;
  const command = $('#sched-cmd').value.trim();
  const type = $('#sched-type').value;
  const threadName = $('#sched-thread-name').value.trim() || undefined;

  if (!workspaceName || !command) { toast('Workspace and command are required', true); return; }

  const schedule = { type };
  if (type === 'daily' || type === 'weekly') schedule.time = $('#sched-time').value;
  if (type === 'interval') {
    schedule.intervalHours = parseInt($('#sched-interval').value) || 6;
    schedule.time = $('#sched-time').value || undefined;
  }
  if (type === 'weekly') {
    schedule.weekdays = [...$$('#sched-weekdays input:checked')].map(el => parseInt(el.value));
  }

  const res = await fetch('/api/schedules', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ workspaceName, command, schedule, threadName })
  });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast('Scheduled task created');
  $('#sched-cmd').value = '';
  $('#sched-thread-name').value = '';
  loadSchedules();
}

async function toggleSchedule(id, enabled) {
  const res = await fetch('/api/schedules/' + id, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ enabled })
  });
  if (!res.ok) { const d = await res.json(); toast(d.error, true); loadSchedules(); return; }
  toast(enabled ? 'Task enabled' : 'Task disabled');
}

async function runSchedule(id) {
  toast('Triggering task...');
  const res = await fetch('/api/schedules/' + id + '/run', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) { toast(d.error, true); return; }
  toast(d.status === 'success' ? 'Task triggered successfully' : 'Task failed: ' + (d.error || 'unknown'), d.status === 'failed');
  loadSchedules();
}

async function deleteSchedule(id) {
  if (!confirm('Delete this scheduled task?')) return;
  const res = await fetch('/api/schedules/' + id, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); toast(d.error, true); return; }
  toast('Task deleted');
  loadSchedules();
}

let currentDetailTaskId = null;
let currentLogsTaskId = null;

function hideSchedDetail() {
  currentDetailTaskId = null;
  $('#sched-detail').style.display = 'none';
}

function hideSchedLogs() {
  currentLogsTaskId = null;
  $('#sched-logs').style.display = 'none';
}

async function showSchedLogs(taskId) {
  if (currentLogsTaskId === taskId && $('#sched-logs').style.display !== 'none') {
    hideSchedLogs();
    return;
  }
  currentLogsTaskId = taskId;
  const res = await fetch('/api/schedules/' + taskId + '/logs');
  const logs = await res.json();
  const tbody = $('#sched-logs-tbody');
  if (!logs.length) { tbody.innerHTML = '<tr><td colspan="3" class="empty">No run history</td></tr>'; }
  else {
    tbody.innerHTML = logs.slice().reverse().map(l => \`<tr>
      <td>\${new Date(l.runAt).toLocaleString()}</td>
      <td><span class="badge" style="\${l.status === 'failed' ? 'background:#5a2727;color:#ff6e6e' : ''}">\${l.status}</span></td>
      <td class="mono">\${escapeHtml(l.threadId || '—')}</td>
    </tr>\`).join('');
  }
  $('#sched-logs').style.display = 'block';
}

function refreshSchedLogs() {
  if (currentLogsTaskId) showSchedLogs(currentLogsTaskId);
}

function formatUtcDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

async function showSchedDetail(taskId) {
  if (currentDetailTaskId === taskId && $('#sched-detail').style.display !== 'none') {
    hideSchedDetail();
    return;
  }
  currentDetailTaskId = taskId;
  const res = await fetch('/api/schedules/' + taskId + '/detail');
  if (!res.ok) { toast('Failed to load detail', true); return; }
  const d = await res.json();
  const nextRun = formatUtcDateTime(d.nextRunAt);
  const body = $('#sched-detail-body');
  body.innerHTML = \`
    <div style="display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; font-size: 0.85rem;">
      <span style="color: #888;">Workspace</span><span>\${escapeHtml(d.workspaceName)}</span>
      <span style="color: #888;">Work Dir</span><span class="mono">\${escapeHtml(d.workspacePath || '—')}</span>
      <span style="color: #888;">Schedule</span><span>\${describeSchedule(d.schedule)}</span>
      <span style="color: #888;">Next Run (UTC)</span><span>\${nextRun}</span>
      <span style="color: #888;">Total Runs</span><span>\${d.totalRuns} (\${d.successRuns} ok, \${d.failedRuns} failed)</span>
      <span style="color: #888;">Created</span><span>\${new Date(d.createdAt).toLocaleString()}</span>
      <span style="color: #888;">Enabled</span><span>\${d.enabled ? '✅ Yes' : '❌ No'}</span>
      <span style="color: #888;">Command</span>
      <div style="display: flex; gap: 6px; align-items: center;">
        <input id="detail-cmd" value="\${escapeHtml(d.command)}" style="flex: 1; padding: 6px 10px; border: 1px solid #3d3d5c; border-radius: 4px; background: #1a1a2e; color: #e0e0e0; font-family: 'SF Mono', monospace; font-size: 0.82rem;" />
        <button class="btn btn-primary btn-sm" onclick="saveSchedCommand('\${d.id}')">Save</button>
      </div>
    </div>
  \`;
  $('#sched-detail').style.display = 'block';
}

async function saveSchedCommand(taskId) {
  const command = $('#detail-cmd').value.trim();
  if (!command) { toast('Command cannot be empty', true); return; }
  const res = await fetch('/api/schedules/' + taskId, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ command })
  });
  if (!res.ok) { const d = await res.json(); toast(d.error, true); return; }
  toast('Command updated (takes effect on next run)');
  loadSchedules();
}

// Init
loadStatus();
loadChannels().then(loadWorkspaces);
loadSessions();
loadSchedules();
// Auto-refresh status every 30s
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;
