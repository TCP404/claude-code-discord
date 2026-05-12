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

// Init
loadStatus();
loadChannels().then(loadWorkspaces);
loadSessions();
// Auto-refresh status every 30s
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;
