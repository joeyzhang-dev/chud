// Live terminal mirror: paints the session's current screen — colours, cursor
// and all — and routes keystrokes back to the real terminal through the main
// process.

const params = new URLSearchParams(location.search);
const uuid = params.get('uuid') || '';
const initialTitle = params.get('title') || 'session';

// Degrade to a no-op bridge if the page is ever opened without the preload,
// so a missing IPC channel can't take the whole window down.
const bridge = window.mirror || {
  onState() {}, sendText() {}, sendKey() {}, setActive() {}, close() {},
};

const titleEl = document.getElementById('title');
const pane = document.getElementById('pane');
const term = document.getElementById('term');
const msg = document.getElementById('msg');
const closeBtn = document.getElementById('close');
const focusHint = document.getElementById('focus-hint');
const headerEl = document.querySelector('header');
const sgrEl = document.getElementById('sgr');

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
let cols = 0;

const nearBottom = () =>
  term.scrollHeight - term.scrollTop - term.clientHeight <= STICK_PX;

const toBottom = () => { term.scrollTop = term.scrollHeight; };

// cmux resolves the Ghostty theme itself, so colours arrive as plain hex. They
// still get checked before being written into a stylesheet — the rule text is
// the one place in this file where a string stops being inert data.
const HEX = /^#[0-9A-Fa-f]{3,8}$/;
const colour = (v) => (typeof v === 'string' && HEX.test(v) ? v : null);

// The terminal's own background stays out of the paint: chud's shell already
// sets one, and repainting every cell with it would just fight the card look.
// Backgrounds that differ from it are real — a selection, a status bar, a diff
// — and those do get drawn.
function styleRules(styles, defaultBg) {
  const out = [];
  for (const id of Object.keys(styles)) {
    if (!/^\d+$/.test(id)) continue;  // a selector is never built from free text
    const st = styles[id];
    const decls = [];
    let fg = colour(st.fg);
    let bg = colour(st.bg);
    if (st.r) { const t = fg; fg = bg; bg = t; }   // inverse
    if (st.h) fg = 'transparent';                  // invisible
    if (fg) decls.push(`color:${fg}`);
    if (bg && bg !== defaultBg) decls.push(`background:${bg}`);
    if (st.b) decls.push('font-weight:600');
    if (st.f) decls.push('opacity:.55');
    if (st.i) decls.push('font-style:italic');
    const lines = [];
    if (st.u) lines.push('underline');
    if (st.s) lines.push('line-through');
    if (st.o) lines.push('overline');
    if (lines.length) decls.push(`text-decoration:${lines.join(' ')}`);
    // Scoped under #term so these outrank the pane's own default colour, which
    // is set on that same id.
    if (decls.length) out.push(`#term .s${id}{${decls.join(';')}}`);
  }
  return out.join('');
}

function span(text, sid, isCursor) {
  const el = document.createElement('span');
  el.className = isCursor ? `s${sid} cur` : `s${sid}`;
  el.textContent = text;
  return el;
}

// Painted with createElement + textContent throughout: screen contents are
// whatever a command decided to print, and none of it is ever markup here.
function paint(frame) {
  const stick = firstPaint || nearBottom();

  sgrEl.textContent = styleRules(frame.styles || {}, colour(frame.bg));

  const cur = frame.cursor;
  const doc = document.createDocumentFragment();
  const rows = frame.rows || [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const onCursorRow = cur && cur.row === r;
    let col = 0;
    for (const seg of row) {
      const text = seg[0];
      const sid = seg[1];
      // The cursor is drawn by splitting whichever span contains it, so it sits
      // in the text flow instead of floating over it on a guessed cell width.
      if (onCursorRow && cur.col >= col && cur.col < col + text.length) {
        const at = cur.col - col;
        if (at > 0) doc.appendChild(span(text.slice(0, at), sid));
        doc.appendChild(span(text.charAt(at), sid, true));
        if (at + 1 < text.length) doc.appendChild(span(text.slice(at + 1), sid));
      } else {
        doc.appendChild(span(text, sid));
      }
      col += text.length;
    }
    // A cursor parked past the last printed column has no span to split.
    if (onCursorRow && cur.col >= col) {
      if (cur.col > col) doc.appendChild(span(' '.repeat(cur.col - col), 0));
      doc.appendChild(span(' ', 0, true));
    }
    if (r < rows.length - 1) doc.appendChild(document.createTextNode('\n'));
  }

  term.replaceChildren(doc);
  fitFontSize();
  if (stick) toBottom();
  firstPaint = false;
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

  // No frame means the pty is gone / unreadable — keep the stale screen hidden
  // but still in the DOM so its scroll position survives a blip.
  if (s.error || !s.frame) {
    msg.title = typeof s.error === 'string' ? s.error : '';
    msg.classList.remove('hidden');
    term.classList.add('faded');
    return;
  }

  msg.classList.add('hidden');
  term.classList.remove('faded');
  cols = s.frame.cols || 0;
  paint(s.frame);
}

bridge.onState(render);

// Resizing changes how many columns fit, so the type is re-fitted before the
// stickiness check is applied against the new layout.
window.addEventListener('resize', () => {
  const stick = nearBottom();
  fitFontSize();
  if (stick) toBottom();
});

// A mirror on another Space or behind a full-screen window is not worth reading
// ten times a second, and Electron's blur alone does not catch that.
document.addEventListener('visibilitychange', () => {
  bridge.setActive(uuid, document.visibilityState === 'visible');
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
  Delete: 'delete',
  // cmux accepts home/end and neither one moves the cursor, so they are sent as
  // the control codes that actually do.
  Home: 'ctrl+a',
  End: 'ctrl+e',
};

// The mac line-editing chords, mapped to what a terminal actually understands.
// Word motion is the odd one out: alt+b / alt+f are accepted by cmux and do
// nothing, while alt+left / alt+right work, so those are passed through as-is.
const META = {
  Backspace: 'ctrl+u',   // ⌘⌫ kill line
  ArrowLeft: 'ctrl+a',   // ⌘← start of line
  ArrowRight: 'ctrl+e',  // ⌘→ end of line
};
const ALT = {
  Backspace: 'ctrl+w',   // ⌥⌫ delete word back
  ArrowLeft: 'alt+left',
  ArrowRight: 'alt+right',
};

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

  // Page keys scroll the mirror. They are deliberately not forwarded: cmux
  // accepts pageup/pagedown and types a literal `~` into the prompt.
  if (!e.metaKey && !e.altKey && !e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    term.scrollTop += (e.key === 'PageUp' ? -1 : 1) * term.clientHeight * 0.9;
    return;
  }

  if (e.metaKey && !e.ctrlKey) {
    const mapped = META[e.key];
    if (mapped) { e.preventDefault(); sendKey(mapped); return; }
    return; // ⌘C / ⌘V / ⌘A stay with the OS
  }

  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const mapped = ALT[e.key];
    if (mapped) { e.preventDefault(); sendKey(mapped); return; }
    return;
  }

  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    const c = e.key.length === 1 ? e.key.toLowerCase() : '';
    if (c >= 'a' && c <= 'z') {
      e.preventDefault();
      sendKey(`ctrl+${c}`);
    }
    return;
  }

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
