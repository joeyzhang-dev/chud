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
const headerEl = document.querySelector('header');

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
let lastText = '';

const nearBottom = () =>
  term.scrollHeight - term.scrollTop - term.clientHeight <= STICK_PX;

const toBottom = () => { term.scrollTop = term.scrollHeight; };

// cmux pads screen rows out to the terminal width. Those trailing spaces draw
// nothing but they widen the grid, which would cost a font size step and hang a
// scrollbar on empty air — so they come off. Leading and interior blank lines
// are part of what the TUI drew and stay; only the dead rows below the last
// line of content are dropped.
function normalize(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/[ \t\r]+$/, '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function longestLine(text) {
  let max = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const len = (nl === -1 ? text.length : nl) - start;
    if (len > max) max = len;
    if (nl === -1) return max;
    start = nl + 1;
  }
}

// Advance width of the monospace stack as a fraction of the font size (~0.6),
// plus slack so the widest row never lands a pixel past the edge.
const CHAR_RATIO = 0.62;
const PAD_PX = 10;    // #term's horizontal padding, per the stylesheet
const GUTTER_PX = 6;  // scrollbar room, so it never covers the last column
const MIN_PX = 8;
const MAX_PX = 13;

let fontPx = 0;

// Wrapping is off, so the only alternative to fitting the grid across the pane
// is a horizontal scrollbar. Shrink the type until the widest row fits.
function fitFontSize() {
  const cols = longestLine(lastText);
  const avail = pane.clientWidth - PAD_PX * 2 - GUTTER_PX;
  if (!cols || avail <= 0) return;
  const px = Math.min(MAX_PX, Math.max(MIN_PX, Math.floor(avail / (cols * CHAR_RATIO))));
  if (px === fontPx) return;
  fontPx = px;
  term.style.fontSize = `${px}px`;
}

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

  const text = normalize(s.text);
  if (!firstPaint && text === lastText) return;

  // Decide before mutating: only chase the tail if the user was already there.
  const stick = firstPaint || nearBottom();
  lastText = text;
  term.textContent = text;
  fitFontSize();
  if (stick) toBottom();
  firstPaint = false;
}

bridge.onState(render);

// Resizing changes how many columns fit, so the type is re-fitted before the
// stickiness check is applied against the new layout.
window.addEventListener('resize', () => {
  const stick = nearBottom();
  fitFontSize();
  if (stick) toBottom();
});

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

// Whether keystrokes are actually going anywhere is not something you can
// guess by looking at the window, so the footer says it outright.
function syncFocus() {
  const on = termFocused();
  pane.classList.toggle('focused', on);
  focusHint.textContent = on ? 'typing live' : 'click to type';
  focusHint.classList.toggle('live', on);
}

term.addEventListener('focus', syncFocus);
term.addEventListener('blur', () => { flush(); syncFocus(); });
window.addEventListener('focus', () => term.focus());
window.addEventListener('beforeunload', flush);

// A click anywhere in the window re-arms typing. Clicks inside the pane focus
// it natively and must keep drag-selection intact, so only the chrome needs
// help: suppress the default blur there, but leave the header alone so the
// window can still be dragged by it.
document.addEventListener('mousedown', (e) => {
  if (term.contains(e.target) || closeBtn.contains(e.target)) return;
  if (!headerEl || !headerEl.contains(e.target)) e.preventDefault();
  term.focus();
});

term.focus();
syncFocus();
// The window is still being shown as this runs; take focus again once it is.
requestAnimationFrame(() => { term.focus(); syncFocus(); });
