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

// The cmux tab name is what the user actually recognises ("chud",
// "discord bot + crm"); fall back to the project folder off-cmux.
function displayName(s) {
  return s.tabTitle || projectName(s);
}

// Keep the repo visible when the tab was renamed to something else.
function contextLabel(s) {
  const proj = projectName(s);
  if (!s.tabTitle) return null;
  return s.tabTitle.toLowerCase().includes(proj.toLowerCase()) ? null : proj;
}

// Sessions you're still working on: anything live right now, plus anything
// touched recently — an IDLE session from 20 minutes ago is still "current",
// it just isn't mid-turn. Only genuinely stale ones go behind the toggle.
// `live` means the session's cmux tab is still open with its agent running —
// that outranks age entirely. Only sessions whose tab is gone fall back to a
// recency window before being tucked behind the toggle.
const RECENT_MS = 60 * 60 * 1000;
const isCurrent = (s) =>
  (s.background && s.status !== 'working' && s.status !== 'needs-input') ? false :
  s.status === 'working' ||
  s.status === 'needs-input' ||
  s.live ||
  (s.status !== 'ended' && Date.now() - s.lastActivity < RECENT_MS);
let showIdle = false;

function cardHtml(s) {
  const note = s.status === 'needs-input' && s.note ? ` · ${esc(s.note)}` : '';
  const branch = s.branch ? ` <span class="branch">⎇ ${esc(s.branch)}</span>` : '';
  const ctx = contextLabel(s);
  const tabs = s.paneTabs > 1 ? `<span class="tabs" title="one of ${s.paneTabs} tabs in this pane">⧉${s.paneTabs}</span>` : '';
  const liveBadge = s.live && s.status !== 'working' ? '<span class="badge live">LIVE</span>' : '';
  const ports = (s.ports || []).length
    ? `<div class="ports">${s.ports.map((p) =>
        `<span class="port" data-port="${p.port}" title="Open http://localhost:${p.port} — ${esc(p.cmd)}">:${p.port}</span>`
      ).join('')}</div>`
    : '';
  return `
    <div class="card ${s.status}" data-key="${esc(s.key)}" title="Click to jump to this session">
      <div class="row">
        <span class="dot ${s.status}"></span>
        <span class="name">${esc(displayName(s))}</span>
        ${tabs}
        <span class="badge ${s.source}">${s.source === 'claude' ? 'CLAUDE' : 'COPILOT'}</span>
        ${liveBadge}
        <span class="mirror-btn" title="Open live mirror (or swipe right)">\u276e</span>
        <span class="time">${timeAgo(s.lastActivity)}</span>
      </div>
      ${ctx ? `<div class="ctx">${esc(ctx)}</div>` : ''}
      <div class="status-line ${s.status}">${STATUS_LABEL[s.status] || s.status}${note}${branch}</div>
      ${ports}
      ${s.title || s.lastPrompt ? `<div class="prompt">${esc(s.title || s.lastPrompt)}</div>` : ''}
      ${s.lastReply && s.status !== 'working' ? `<div class="reply">${esc(s.lastReply)}</div>` : ''}
    </div>`;
}

function render() {
  const list = document.getElementById('list');
  const sessions = state.sessions || [];
  const active = sessions.filter(isCurrent);
  const idle = sessions.filter((s) => !isCurrent(s));
  const live = sessions.filter((s) => s.status === 'working' || s.status === 'needs-input').length;
  document.getElementById('count').textContent = `${live} active · ${sessions.length}`;

  if (!sessions.length) {
    list.innerHTML = '<div class="empty">No recent sessions.<br>Start a Claude Code or Copilot session and it will appear here.</div>';
    return;
  }

  const activeHtml = active.length
    ? active.map(cardHtml).join('')
    : '<div class="empty quiet">Nothing active or recent.</div>';

  const toggle = idle.length
    ? `<button class="toggle ${showIdle ? 'open' : ''}" id="toggle-idle">
         <span class="chev">${showIdle ? '▾' : '▸'}</span>
         ${showIdle ? 'Hide' : 'Show'} ${idle.length} older
       </button>`
    : '';

  list.innerHTML = activeHtml + toggle + (showIdle ? idle.map(cardHtml).join('') : '');

  const btn = document.getElementById('toggle-idle');
  if (btn) btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showIdle = !showIdle;
    sel = -1;
    render();
  });
  applySel();
}

// ---- settings ----
const $ = (id) => document.getElementById(id);

function applySettingsUI(s) {
  lastSettings = s;
  $('op-f').value = s.focusedOpacity;
  $('op-u').value = s.unfocusedOpacity;
  $('op-f-v').textContent = Math.round(s.focusedOpacity * 100) + '%';
  $('op-u-v').textContent = Math.round(s.unfocusedOpacity * 100) + '%';
  $('compact').checked = !!s.compact;
  $('app').classList.toggle('compact', !!s.compact);
  $('follow').checked = !!s.followDisplay;
  $('mirror-click').checked = s.mirrorOnClick !== false;
  $('done-sound').checked = !!s.doneSound;
  $('done-vol').value = s.doneSoundVolume ?? 1;
  $('done-vol-v').textContent = Math.round((s.doneSoundVolume ?? 1) * 100) + '%';
  $('done-sound-dir').value = s.doneSoundDir || '';
  const sym = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' };
  const pretty = (acc) => (acc || '').split('+').map((p) => sym[p] || p).join(' ');
  if (document.activeElement !== $('hotkey')) $('hotkey').value = pretty(s.hotkey);
  if (document.activeElement !== $('toggle-hotkey')) $('toggle-hotkey').value = pretty(s.toggleHotkey);
  const hint = $('hotkey-hint');
  if (s.hotkeyError) {
    hint.textContent = s.hotkeyError;
    hint.classList.add('error');
  } else {
    hint.textContent = 'Press hotkey from any app · ↑↓ navigate · Enter jump · Esc back';
    hint.classList.remove('error');
  }
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
$('follow').addEventListener('change', (e) => {
  window.hud.setSettings({ followDisplay: e.target.checked });
});
$('mirror-click').addEventListener('change', (e) => {
  window.hud.setSettings({ mirrorOnClick: e.target.checked });
});
$('done-sound').addEventListener('change', (e) => {
  window.hud.setSettings({ doneSound: e.target.checked });
});
// ---- per-sound settings (expandable) ----
let soundCfg = {};
async function renderSoundList() {
  const list = await window.hud.listSounds();
  soundCfg = {};
  for (const x of list) soundCfg[x.name] = { enabled: x.enabled, volume: x.volume };
  $('sound-list').innerHTML = list.length ? list.map((x) => `
    <div class="srow" data-n="${esc(x.name)}">
      <input type="checkbox" ${x.enabled ? 'checked' : ''} title="Enable this sound">
      <span class="nm" title="${esc(x.name)}">${esc(x.name)}</span>
      <input type="range" min="0" max="1" step="0.05" value="${x.volume}">
      <span class="val">${Math.round(x.volume * 100)}%</span>
    </div>`).join('') : '<div class="hint">No sound files in the folder.</div>';
}
$('sound-adv').addEventListener('click', async () => {
  const el = $('sound-list');
  el.classList.toggle('hidden');
  $('sound-adv').querySelector('.chev').textContent = el.classList.contains('hidden') ? '\u25b8' : '\u25be';
  if (!el.classList.contains('hidden')) await renderSoundList();
});
let srowTimer = null;
$('sound-list').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const n = e.target.closest('.srow')?.dataset.n;
  if (!n) return;
  soundCfg[n] = { ...soundCfg[n], enabled: e.target.checked };
  window.hud.setSettings({ soundConfig: soundCfg });
});
$('sound-list').addEventListener('input', (e) => {
  if (e.target.type !== 'range') return;
  const row = e.target.closest('.srow'); const n = row?.dataset.n;
  if (!n) return;
  const v = parseFloat(e.target.value);
  row.querySelector('.val').textContent = Math.round(v * 100) + '%';
  soundCfg[n] = { ...soundCfg[n], volume: v };
  clearTimeout(srowTimer);
  srowTimer = setTimeout(() => {
    window.hud.setSettings({ soundConfig: soundCfg });
    window.hud.previewFile(n, v * (parseFloat($('done-vol').value) || 1)); // hear THIS sound at its effective volume
  }, 200);
});

let volPreviewTimer = null;
$('done-vol').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('done-vol-v').textContent = Math.round(v * 100) + '%';
  window.hud.setSettings({ doneSoundVolume: v });
  clearTimeout(volPreviewTimer); // preview once per pause in the drag
  volPreviewTimer = setTimeout(() => window.hud.previewSound(v), 200);
});
$('done-sound-dir').addEventListener('click', async (e) => {
  const dir = await window.hud.pickSoundDir(); // native folder dialog; persists on pick
  if (dir) e.target.value = dir;
});

// ---- hotkey recorder: click the field, press the combo ----
let lastSettings = {};

function accFromEvent(e) {
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const code = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code.startsWith('Arrow')) key = code.slice(5);
  else if (code === 'Enter') key = 'Return';
  else if (code === 'Tab') key = 'Tab';
  else {
    const punct = { Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backquote: '`', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
    key = punct[code] || null;
  }
  if (!key) return null;
  if (!mods.length && !/^F\d/.test(key)) return null; // bare keys only allowed for F-keys
  return [...mods, key].join('+');
}

function prettyMods(e) {
  const parts = [];
  if (e.metaKey) parts.push('⌘');
  if (e.ctrlKey) parts.push('⌃');
  if (e.altKey) parts.push('⌥');
  if (e.shiftKey) parts.push('⇧');
  return parts.join('');
}

function setupRecorder(inputId, settingsKey) {
  const el = $(inputId);
  el.addEventListener('focus', () => {
    window.hud.suspendHotkey();
    el.value = 'Press shortcut…';
    $('hotkey-hint').textContent = 'Press keys · Esc cancel · ⌫ clear hotkey';
  });
  el.addEventListener('blur', () => {
    window.hud.resumeHotkey();
    applySettingsUI(lastSettings);
  });
  el.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { el.blur(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      window.hud.setSettings({ [settingsKey]: '' });
      el.blur();
      return;
    }
    const acc = accFromEvent(e);
    if (acc) {
      window.hud.setSettings({ [settingsKey]: acc });
      el.blur();
    } else {
      const mods = prettyMods(e);
      el.value = mods ? mods + '…' : 'Press shortcut…';
    }
  });
}
setupRecorder('hotkey', 'hotkey');
setupRecorder('toggle-hotkey', 'toggleHotkey');

window.hud.onSettings(applySettingsUI);
window.hud.getSettings().then(applySettingsUI);

// ---- keyboard navigation (global hotkey flow) ----
let sel = -1;

function applySel() {
  const cards = document.querySelectorAll('.card');
  cards.forEach((c, i) => c.classList.toggle('selected', i === sel));
  if (sel >= 0 && cards[sel]) cards[sel].scrollIntoView({ block: 'nearest' });
}

function moveSel(delta) {
  const n = document.querySelectorAll('.card').length;
  if (!n) return;
  sel = sel < 0 ? 0 : Math.min(n - 1, Math.max(0, sel + delta));
  applySel();
}

// Cmd+S / Cmd+R while the HUD is focused — reuse the buttons' own handlers.
window.hud.onKb((a) => {
  if (a === 'settings') $('gear').click();
  else if (a === 'refresh') $('refresh').click();
});
window.hud.onHotkeyFocus(() => { sel = 0; applySel(); });
window.hud.onNavClear(() => { sel = -1; applySel(); });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter' && sel >= 0) {
    e.preventDefault();
    const card = document.querySelectorAll('.card')[sel];
    const k = card?.dataset.key;
    if (k) (window.hud.focusSession(k));
    sel = -1; applySel();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    sel = -1; applySel();
    window.hud.returnFocus();
  }
});

window.hud.onState((s) => { state = s; render(); });
window.hud.getState().then((s) => { state = s; render(); });
document.getElementById('close').addEventListener('click', () => window.hud.close());
document.getElementById('refresh').addEventListener('click', async (e) => {
  const el = e.currentTarget;
  el.classList.add('spin');
  try { await window.hud.refresh(); } finally { setTimeout(() => el.classList.remove('spin'), 600); }
});
document.getElementById('list').addEventListener('click', (e) => {
  // Port chips open the browser instead of jumping to the session.
  const chip = e.target.closest('.port');
  if (chip) {
    e.stopPropagation();
    window.hud.openPort(chip.dataset.port);
    return;
  }
  const mbtn = e.target.closest('.mirror-btn');
  if (mbtn) {
    e.stopPropagation();
    const c = mbtn.closest('.card');
    if (c?.dataset.key && lastSettings.mirrorOnClick !== false) window.hud.openMirror(c.dataset.key);
    return;
  }
  const card = e.target.closest('.card');
  if (!card || !card.dataset.key) return;
  card.classList.add('clicked');
  setTimeout(() => card.classList.remove('clicked'), 400);
  const k = card.dataset.key;
  (window.hud.focusSession(k));
});
// Two-finger swipe right on a card opens its live mirror.
let lastSwipe = 0;
document.getElementById('list').addEventListener('wheel', (e) => {
  if (e.deltaX >= -25 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
  const card = e.target.closest('.card');
  if (!card?.dataset.key || lastSettings.mirrorOnClick === false) return;
  if (Date.now() - lastSwipe < 900) return;
  lastSwipe = Date.now();
  window.hud.openMirror(card.dataset.key);
}, { passive: true });

setInterval(render, 15000);
