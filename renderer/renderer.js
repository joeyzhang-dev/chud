let state = { sessions: [] };

const STATUS_LABEL = {
  working: 'WORKING',
  'needs-input': 'NEEDS INPUT',
  done: 'DONE',
  idle: 'IDLE',
  ended: 'ENDED',
};

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = s || '';
  return d.innerHTML;
}

function projectName(s) {
  if (!s.cwd) return s.sessionId ? s.sessionId.slice(0, 8) : '?';
  return s.cwd.split('/').filter(Boolean).pop() || s.cwd;
}

function render() {
  const list = document.getElementById('list');
  const sessions = state.sessions || [];
  const active = sessions.filter((s) => s.status === 'working' || s.status === 'needs-input').length;
  document.getElementById('count').textContent = `${active} active · ${sessions.length}`;

  if (!sessions.length) {
    list.innerHTML = '<div class="empty">No recent sessions.<br>Start a Claude Code or Copilot session and it will appear here.</div>';
    return;
  }

  list.innerHTML = sessions.map((s) => {
    const note = s.status === 'needs-input' && s.note ? ` · ${esc(s.note)}` : '';
    const branch = s.branch ? ` <span class="branch">⎇ ${esc(s.branch)}</span>` : '';
    return `
    <div class="card ${s.status}" data-key="${esc(s.key)}" title="Click to jump to this session">
      <div class="row">
        <span class="dot ${s.status}"></span>
        <span class="name">${esc(projectName(s))}</span>
        <span class="badge ${s.source}">${s.source === 'claude' ? 'CLAUDE' : 'COPILOT'}</span>
        <span class="time">${timeAgo(s.lastActivity)}</span>
      </div>
      <div class="status-line ${s.status}">${STATUS_LABEL[s.status] || s.status}${note}${branch}</div>
      ${s.lastPrompt ? `<div class="prompt">${esc(s.lastPrompt)}</div>` : ''}
      ${s.lastReply && s.status !== 'working' ? `<div class="reply">${esc(s.lastReply)}</div>` : ''}
    </div>`;
  }).join('');
}

// ---- settings ----
const $ = (id) => document.getElementById(id);

function applySettingsUI(s) {
  $('op-f').value = s.focusedOpacity;
  $('op-u').value = s.unfocusedOpacity;
  $('op-f-v').textContent = Math.round(s.focusedOpacity * 100) + '%';
  $('op-u-v').textContent = Math.round(s.unfocusedOpacity * 100) + '%';
  $('compact').checked = !!s.compact;
  $('app').classList.toggle('compact', !!s.compact);
}

$('gear').addEventListener('click', () => {
  $('settings').classList.toggle('hidden');
  $('gear').classList.toggle('active');
});
$('op-f').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('op-f-v').textContent = Math.round(v * 100) + '%';
  window.hud.setSettings({ focusedOpacity: v });
});
$('op-u').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('op-u-v').textContent = Math.round(v * 100) + '%';
  window.hud.setSettings({ unfocusedOpacity: v });
});
$('compact').addEventListener('change', (e) => {
  window.hud.setSettings({ compact: e.target.checked });
});

window.hud.onSettings(applySettingsUI);
window.hud.getSettings().then(applySettingsUI);

window.hud.onState((s) => { state = s; render(); });
window.hud.getState().then((s) => { state = s; render(); });
document.getElementById('close').addEventListener('click', () => window.hud.close());
document.getElementById('list').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !card.dataset.key) return;
  card.classList.add('clicked');
  setTimeout(() => card.classList.remove('clicked'), 400);
  window.hud.focusSession(card.dataset.key);
});
setInterval(render, 15000);
