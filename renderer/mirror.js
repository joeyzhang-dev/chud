// Live terminal mirror: paints the session's current screen text and routes
// keystrokes back to the real terminal through the main process.

const params = new URLSearchParams(location.search);
const uuid = params.get('uuid') || '';
const initialTitle = params.get('title') || 'session';

// Degrade to a no-op bridge if the page is ever opened without the preload,
// so a missing IPC channel can't take the whole window down.
const bridge = window.mirror || {
  onState() {}, sendText() {}, sendKey() {}, close() {},
};

const titleEl = document.getElementById('title');
const pane = document.getElementById('pane');
const term = document.getElementById('term');
const msg = document.getElementById('msg');
const closeBtn = document.getElementById('close');
const focusHint = document.getElementById('focus-hint');

function setTitle(t) {
  const name = String(t || '').trim() || 'session';
  titleEl.textContent = `⧉ ${name}`;
  titleEl.title = name;
  document.title = `${name} · mirror`;
}
setTitle(initialTitle);

/* ------------------------------- rendering ------------------------------- */

// How close to the tail counts as "following along".
const STICK_PX = 40;
let firstPaint = true;

const nearBottom = () =>
  term.scrollHeight - term.scrollTop - term.clientHeight <= STICK_PX;

const toBottom = () => { term.scrollTop = term.scrollHeight; };

function render(s) {
  if (!s || typeof s !== 'object') return;
  if (typeof s.title === 'string' && s.title.trim()) setTitle(s.title);

  // No text means the pty is gone / unreadable — keep the stale screen hidden
  // but still in the DOM so its scroll position survives a blip.
  if (s.error || s.text == null) {
    msg.title = typeof s.error === 'string' ? s.error : '';
    msg.classList.remove('hidden');
    term.classList.add('faded');
    return;
  }

  msg.classList.add('hidden');
  term.classList.remove('faded');

  const text = String(s.text);
  if (!firstPaint && text === term.textContent) return;

  // Decide before mutating: only chase the tail if the user was already there.
  const stick = firstPaint || nearBottom();
  term.textContent = text;
  if (stick) toBottom();
  firstPaint = false;
}

bridge.onState(render);

window.addEventListener('resize', () => { if (nearBottom()) toBottom(); });

/* -------------------------------- closing -------------------------------- */

function closeWindow() {
  bridge.close(uuid);
}
closeBtn.addEventListener('click', closeWindow);

/* -------------------------------- keyboard ------------------------------- */

// Typed characters are coalesced so a burst of keystrokes becomes one write.
const FLUSH_MS = 30;
let buf = '';
let flushTimer = null;

function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buf) return;
  const out = buf;
  buf = '';
  bridge.sendText(uuid, out);
}

function typeChar(ch) {
  buf += ch;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_MS);
}

// Flush first so buffered text always lands ahead of the key that follows it.
function sendKey(name) {
  flush();
  bridge.sendKey(uuid, name);
}

const SPECIAL = {
  Enter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const CTRL = new Set(['c', 'u', 'd', 'r', 'l']);

const termFocused = () =>
  document.activeElement === term || term.contains(document.activeElement);

// Esc closes whether or not the pane has focus — closing is local, nothing
// about it reaches the session.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  closeWindow();
});

// Everything else is routed only while the terminal pane itself has focus.
term.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return; // handled above

  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    const c = e.key.toLowerCase();
    if (CTRL.has(c)) {
      e.preventDefault();
      sendKey(`ctrl+${c}`);
    }
    return;
  }

  // Leave Cmd/Alt combos alone so Cmd+V still raises a paste event and
  // Cmd+C still copies the selection.
  if (e.metaKey || e.altKey) return;

  const special = SPECIAL[e.key];
  if (special) {
    e.preventDefault();
    sendKey(special);
    return;
  }

  if (e.key.length === 1) {
    e.preventDefault();
    typeChar(e.key);
  }
});

document.addEventListener('paste', (e) => {
  if (!termFocused()) return;
  e.preventDefault();
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text) return;
  flush();
  bridge.sendText(uuid, text);
});

/* ------------------------------ focus state ------------------------------ */

function syncFocus() {
  const on = termFocused();
  pane.classList.toggle('focused', on);
  focusHint.classList.toggle('hidden', on);
}

term.addEventListener('focus', syncFocus);
term.addEventListener('blur', () => { flush(); syncFocus(); });
window.addEventListener('focus', () => term.focus());
window.addEventListener('beforeunload', flush);

term.focus();
syncFocus();
