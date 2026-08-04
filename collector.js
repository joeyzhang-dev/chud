const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = 4471;
const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';

// cmux's socket only trusts descendants of the cmux app unless a socket
// password is configured (automation.socketControlMode: "password").
function cmuxPassword() {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.config', 'cmux', 'cmux.json'), 'utf8');
    const m = cfg.match(/"socketPassword"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function run(cmd, args) {
  const env = { ...process.env, CMUX_QUIET: '1' };
  const pw = cmuxPassword();
  if (pw) env.CMUX_SOCKET_PASSWORD = pw;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, env }, (err, stdout, stderr) => {
      if (err) {
        try {
          fs.appendFileSync('/tmp/session-hud-run.log',
            `${new Date().toISOString()} ${cmd} ${args.join(' ')}\nERR: ${err.message}\nSTDERR: ${stderr}\n\n`);
        } catch { /* ignore */ }
      }
      resolve(err ? null : stdout);
    });
  });
}
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const COPILOT_DB = path.join(os.homedir(), '.copilot', 'session-store.db');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 262144;

class Collector {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.sessions = new Map(); // key: source:sessionId
    this.fileCache = new Map(); // transcript path -> mtimeMs
    this.onScreenshot = null;
    // Hook-reported identity survives collector restarts on disk. Losing it
    // orphaned every session (focus:null) until its next prompt.
    this.focusFile = path.join(os.homedir(), '.config', 'chud', 'focus.json');
    try { this.persistedFocus = JSON.parse(fs.readFileSync(this.focusFile, 'utf8')); }
    catch { this.persistedFocus = {}; }
  }

  savePersistedFocus() {
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const [id, f] of Object.entries(this.persistedFocus)) {
        if (!f || (f.ts || 0) < cutoff) delete this.persistedFocus[id];
      }
      fs.mkdirSync(path.dirname(this.focusFile), { recursive: true });
      fs.writeFileSync(this.focusFile, JSON.stringify(this.persistedFocus));
    } catch { /* best effort */ }
  }

  start() {
    this.startServer();
    this.scanClaude();
    this.pollCopilot();
    this.refreshCmux();
    this.pollPorts();
    this.pollAgents();
    setInterval(() => this.scanClaude(), 5000);
    setInterval(() => this.pollCopilot(), 5000);
    setInterval(() => this.refreshCmux(), 4000);
    setInterval(() => this.pollPorts(), 5000);
    setInterval(() => this.pollAgents(), 3000);
    setInterval(() => this.pollScreens(), 6000);
    setInterval(() => this.emit(), 10000); // refresh relative times
  }

  emit() {
    this.broadcast(this.getState());
  }

  getState() {
    const now = Date.now();
    const list = [...this.sessions.values()]
      .filter((s) => now - s.lastActivity < MAX_AGE_MS)
      .map((s) => ({ ...s, status: this.effectiveStatus(s, now) }));
    const rank = { 'needs-input': 0, working: 1, done: 2, idle: 3, ended: 4 };
    // Deterministic tiebreak so equal-rank cards never swap between emits.
    list.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lastActivity - a.lastActivity)
      || String(a.key).localeCompare(String(b.key)));
    return { sessions: list, updatedAt: now };
  }

  effectiveStatus(s, now) {
    if (s.hookDriven && s.status === 'needs-input') return 'needs-input';
    // The tab's own status bar says a turn is in flight — believe it. This is
    // how a Copilot session mid-turn reads as working even though its DB only
    // updates at turn boundaries.
    if (s.screenWorking) return 'working';
    let status = s.status;
    if (!s.hookDriven) {
      // Copilot writes its DB at turn BOUNDARIES, so a fresh row means a turn
      // just finished — done, never working. Only the screen check may claim
      // working for it. Claude transcripts do stream mid-turn, so recency
      // still implies working there.
      const recent = now - s.lastActivity < 90000;
      status = recent ? (s.source === 'copilot' ? 'done' : 'working') : 'idle';
    }
    // Screen shows a prompt: recency-inferred "working" is wrong.
    if (s.screenWorking === false && status === 'working' && !s.hookDriven) status = 'idle';
    // A "working" session silent for 30+ min probably finished without us seeing it
    if (status === 'working' && now - s.lastActivity > 30 * 60 * 1000) status = 'idle';
    if (status === 'idle' && now - s.lastActivity < 10 * 60 * 1000) status = 'done';
    return status;
  }

  upsert(key, fields) {
    const existing = this.sessions.get(key) || {};
    this.sessions.set(key, { ...existing, ...fields, key });
  }

  // ---------- Claude Code: hook event server ----------

  startServer() {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && (req.url === '/event' || req.url === '/env')) {
        const isEnv = req.url === '/env';
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (isEnv) this.handleEnvInfo(data);
            else this.handleHookEvent(data);
          } catch { /* ignore malformed */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      } else if (req.method === 'GET' && req.url.startsWith('/focus')) {
        const key = new URL(req.url, 'http://x').searchParams.get('key');
        this.focusSession(key).then((result) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(result);
        });
      } else if (req.method === 'GET' && req.url.startsWith('/refresh')) {
        this.refreshAll().then((n) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: n }));
        });
      } else if (req.method === 'GET' && req.url.startsWith('/audit')) {
        this.audit().then((a) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(a, null, 2));
        }).catch((e) => { res.writeHead(500); res.end(String(e && e.message)); });
      } else if (req.method === 'GET' && req.url.startsWith('/agents')) {
        agentProcesses().then((a) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(a, null, 2));
        }).catch((e) => { res.writeHead(500); res.end(String(e && e.message)); });
      } else if (req.method === 'GET' && req.url.startsWith('/state')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getState(), null, 2));
      } else if (req.method === 'GET' && req.url.startsWith('/surfaces')) {
        this.cmuxSurfaces().then((s) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(s));
        });
      } else if (req.method === 'GET' && req.url.startsWith('/settings')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const patch = {};
        if (q.has('focused')) patch.focusedOpacity = parseFloat(q.get('focused'));
        if (q.has('unfocused')) patch.unfocusedOpacity = parseFloat(q.get('unfocused'));
        if (q.has('compact')) patch.compact = q.get('compact') === '1';
        if (this.onSettingsDebug) this.onSettingsDebug(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(patch));
      } else if (req.method === 'GET' && req.url.startsWith('/shot')) {
        const file = path.join(os.tmpdir(), 'session-hud-shot.png');
        if (this.onScreenshot) {
          this.onScreenshot(file).then(() => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(file);
          }).catch((e) => { res.writeHead(500); res.end(String(e)); });
        } else { res.writeHead(404); res.end(); }
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('session-hud collector');
      }
    });
    this.server.on('error', (e) => console.error('collector server error:', e.message));
    this.server.listen(PORT, '127.0.0.1');
  }

  handleEnvInfo(data) {
    if (!data.session_id) return;
    const key = `claude:${data.session_id}`;
    const focus = {};
    if (data.cmuxWorkspace) focus.cmuxWorkspace = data.cmuxWorkspace;
    if (data.cmuxSurface) focus.cmuxSurface = data.cmuxSurface;
    if (data.bundle) focus.bundle = data.bundle;
    if (data.termProgram) focus.termProgram = data.termProgram;
    // cmux names each tab's CLI shim dir after that tab's surface UUID, so
    // $PATH identifies the exact tab even when CMUX_SURFACE_ID is unset.
    const shim = shimSurfaceId(data.path);
    if (shim) focus.cmuxShim = shim;
    // Controlling tty, matched against `tty=ttysNNN` in `cmux tree`. Detached
    // shells report "??" — ignore anything that isn't a real terminal.
    const tty = String(data.tty || '').replace(/^\/dev\//, '').trim();
    if (/^ttys\d+$/.test(tty)) focus.tty = tty;
    const existing = this.sessions.get(key) || {};
    const merged = { ...existing.focus, ...focus };
    this.sessions.set(key, { ...existing, key, focus: merged });
    this.persistedFocus[data.session_id] = { ...merged, ts: Date.now() };
    this.savePersistedFocus();
  }

  // Bring the terminal/app hosting this session to the front
  async focusSession(key) {
    const s = this.sessions.get(key);
    if (!s) return 'unknown session';

    // Copilot "autopilot" sessions live in the GitHub Copilot desktop app,
    // never in a terminal — go straight there.
    if (s.source === 'copilot' && s.client === 'github/autopilot') {
      await run('open', ['-b', 'com.github.githubapp']);
      return 'activated GitHub Copilot app';
    }

    // Locate the surface in cmux's CURRENT tree (handles moved tabs/workspaces).
    // The card's displayed tab is authoritative: clicking goes where it says.
    const surfaces = await this.cmuxSurfaces();
    const target = (s.surfaceUuid && surfaces.find((x) => x.uuid === s.surfaceUuid))
      || this.resolveSurface(s, surfaces);

    if (target) {
      // Full navigation: window -> workspace -> pane/tab. focus-panel only
      // searches the active workspace unless --workspace is passed explicitly.
      if (target.windowUuid) await run(CMUX_BIN, ['focus-window', '--window', target.windowUuid]);
      await run(CMUX_BIN, ['select-workspace', '--workspace', target.workspaceUuid]);
      await run(CMUX_BIN, ['focus-panel', '--panel', target.uuid, '--workspace', target.workspaceUuid]);
      await run('open', ['-b', 'com.cmuxterm.app']);
      run(CMUX_BIN, ['trigger-flash', '--surface', target.uuid, '--workspace', target.workspaceUuid]);
      return 'focused cmux surface';
    }

    // Fallback: just activate the hosting app
    if (s.focus?.bundle) {
      await run('open', ['-b', s.focus.bundle]);
      return 'activated app ' + s.focus.bundle;
    }
    if (s.source === 'copilot') {
      // Copilot session with no matching cmux terminal -> it lives in the
      // GitHub Copilot desktop app (no session deep-links exist yet).
      await run('open', ['-b', 'com.github.githubapp']);
      return 'activated GitHub Copilot app';
    }
    await run('open', ['-b', 'com.cmuxterm.app']);
    return 'activated cmux (no precise match)';
  }

  // Parse `cmux tree --all` into a flat surface list with full context.
  // A "surface" is a tab; a pane may hold several, so we also record the
  // pane's tab siblings to disambiguate names like "chud" vs "discord bot + crm".
  async cmuxSurfaces() {
    const out = await run(CMUX_BIN, ['tree', '--all', '--id-format', 'both']);
    if (!out) return [];
    const UUID = '([0-9A-Fa-f-]{36})';
    const surfaces = [];
    let windowUuid = null;
    let workspaceUuid = null;
    let workspaceTitle = null;
    let paneUuid = null;
    for (const line of out.split('\n')) {
      let m;
      if ((m = line.match(new RegExp(`window window:\\d+ ${UUID}`)))) {
        windowUuid = m[1];
      } else if ((m = line.match(new RegExp(`workspace workspace:\\d+ ${UUID}(?: "([^"]*)")?`)))) {
        workspaceUuid = m[1];
        workspaceTitle = m[2] || null;
      } else if ((m = line.match(new RegExp(`pane pane:\\d+ ${UUID}`)))) {
        paneUuid = m[1];
      } else if ((m = line.match(new RegExp(`surface surface:\\d+ ${UUID} \\[(terminal|browser)\\] "([^"]*)"`)))) {
        const tty = (line.match(/\btty=(\S+)/) || [])[1] || null;
        surfaces.push({
          uuid: m[1],
          type: m[2],
          title: m[3],                    // original case, for display
          match: m[3].toLowerCase(),      // folded, for heuristic matching
          selected: / \[selected\]/.test(line),
          tty,
          windowUuid,
          workspaceUuid,
          workspaceTitle,
          paneUuid,
        });
      }
    }
    // Count tabs per pane so the UI can tell when a name is one of several.
    const perPane = new Map();
    for (const s of surfaces) perPane.set(s.paneUuid, (perPane.get(s.paneUuid) || 0) + 1);
    for (const s of surfaces) s.paneTabs = perPane.get(s.paneUuid) || 1;
    return surfaces;
  }

  // Resolve which cmux tab a session lives in, strongest signal first.
  resolveSurface(s, surfaces) {
    if (!surfaces.length) return null;
    const term = surfaces.filter((x) => x.type === 'terminal');
    return this.resolveExact(s, term) || matchSurfaceByTitle(term, s) || null;
  }

  // Exact identity only. NOTE: never match on tty — `cmux tree` reports the
  // pty a surface was created with, which goes stale after agent-resume.
  // Shims (the per-tab dir cmux puts on PATH) are verified accurate against
  // `cmux read-screen`.
  resolveExact(s, term) {
    const byUuid = (id) => (id ? term.find((x) => x.uuid.toLowerCase() === String(id).toLowerCase()) : null);
    return (
      byUuid(s.focus?.cmuxSurface) ||   // explicit env var (usually unset)
      byUuid(s.focus?.cmuxShim) ||      // hook-reported $PATH shim
      byUuid(s.procShim) ||             // shim read from the live process env
      null
    );
  }

  // Attach live cmux tab names to sessions, and mark the ones whose tab is
  // still open with a running agent — those are "live" regardless of how long
  // they've sat idle, because an idle prompt in an open tab is still your work.
  async refreshCmux() {
    const surfaces = await this.cmuxSurfaces().catch(() => []);
    if (!surfaces.length) return;
    this.surfaces = surfaces;

    const term = surfaces.filter((x) => x.type === 'terminal');
    const claimed = new Set();   // surface uuids already assigned
    const assign = new Map();    // session key -> surface

    // Exact identity claims first (newest session wins a contested surface),
    // then heuristics fill in from whatever is left — so a fuzzy title match
    // can never steal a tab from a session that knows its surface UUID.
    const byRecency = [...this.sessions.entries()].sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0));
    for (const [key, s] of byRecency) {
      let hit = null;
      try { hit = this.resolveExact(s, term); } catch { /* skip */ }
      if (hit && !claimed.has(hit.uuid)) { claimed.add(hit.uuid); assign.set(key, hit); }
    }
    for (const [key, s] of byRecency) {
      if (assign.has(key)) continue;
      let hit = null;
      try { hit = matchSurfaceByTitle(term.filter((x) => !claimed.has(x.uuid)), s); } catch { /* skip */ }
      if (hit) { claimed.add(hit.uuid); assign.set(key, hit); }
    }

    let changed = false;
    for (const [key, s] of this.sessions) {
      const hit = assign.get(key) || null;
      const tab = hit ? hit.title : null;
      const ws = hit ? hit.workspaceTitle : null;
      const siblings = hit ? hit.paneTabs : 0;
      const uuid = hit ? hit.uuid : null;
      if (s.tabTitle !== tab || s.workspaceTitle !== ws || s.paneTabs !== siblings || s.surfaceUuid !== uuid) {
        this.sessions.set(key, {
          ...s, tabTitle: tab, workspaceTitle: ws, paneTabs: siblings, cmux: !!hit, surfaceUuid: uuid,
        });
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // Liveness runs independently of cmux: a hiccup talking to the cmux socket
  // must never hide a session that is demonstrably running.
  async pollAgents() {
    const agents = await agentProcesses().catch(() => []);
    if (!agents.length) return;
    this.adoptAgents(agents);

    // Liveness only. CPU was tried as a "generating right now" signal and
    // measured to be non-discriminating: an idle Copilot TUI repainting its
    // prompt burns MORE cpu-time per interval (0.3-0.9s/5s) than a Claude
    // session actively streaming tokens (0.35s/5s). Screens (`cmux
    // read-screen`, see /audit) are the only honest work-in-progress signal;
    // until one exists per source, status comes from hooks (Claude) and
    // turn-boundary writes (Copilot), and `live` just means "agent still open".
    const liveCwds = new Set();
    for (const a of agents) if (a.cwd) liveCwds.add(`${a.kind} ${a.cwd}`);

    // Among sessions sharing a cwd only the most recent counts, so a project
    // with eight historical sessions yields one card, not eight.
    const newest = new Map();
    for (const [key, s] of this.sessions) {
      if (!s.cwd || !s.source) continue;
      const k = `${s.source} ${s.cwd}`;
      if (!liveCwds.has(k)) continue;
      const prev = newest.get(k);
      if (!prev || s.lastActivity > prev.lastActivity) newest.set(k, { key, lastActivity: s.lastActivity });
    }
    const liveKeys = new Set([...newest.values()].map((v) => v.key));

    // Bind processes to sessions where the evidence is exact, giving the
    // session that process's tab shim:
    //  1. a --resume arg that is unique across processes (two processes can
    //     claim the same id after a hibernation restore — only trust singles);
    //  2. transcript birth time within 3 min of process start;
    //  3. sole agent of its kind in a cwd -> the newest session there.
    const shimFor = new Map(); // session key -> shim
    const resumeCounts = new Map();
    for (const a of agents) if (a.resume) resumeCounts.set(a.resume, (resumeCounts.get(a.resume) || 0) + 1);
    const procsPerCwd = new Map();
    for (const a of agents) {
      if (a.cwd) procsPerCwd.set(`${a.kind} ${a.cwd}`, (procsPerCwd.get(`${a.kind} ${a.cwd}`) || 0) + 1);
    }
    for (const a of agents) {
      if (!a.shim) continue;
      if (a.resume && resumeCounts.get(a.resume) === 1 && this.sessions.has(`claude:${a.resume}`)) {
        shimFor.set(`claude:${a.resume}`, a.shim);
        continue;
      }
      if (a.kind === 'claude' && a.startedAt) {
        const cands = [...this.sessions.entries()].filter(([, s]) =>
          s.source === 'claude' && s.birth && Math.abs(s.birth - a.startedAt) < 180000);
        if (cands.length === 1) { shimFor.set(cands[0][0], a.shim); continue; }
      }
      if (a.cwd && procsPerCwd.get(`${a.kind} ${a.cwd}`) === 1) {
        const n = newest.get(`${a.kind} ${a.cwd}`);
        if (n) shimFor.set(n.key, a.shim);
      }
    }

    let changed = false;
    for (const [key, s] of this.sessions) {
      const live = liveKeys.has(key);
      const procShim = shimFor.get(key) || null;
      if (s.live !== live || s.agentBusy || s.procShim !== procShim) {
        this.sessions.set(key, { ...s, live, procShim, agentBusy: false });
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // The screen is the only source that says "generating right now" for every
  // agent kind: the working status bar contains "esc to interrupt" (Claude
  // Code and Copilot CLI both), and only while a turn is running. Check just
  // the last few lines so conversation text can't false-positive.
  async pollScreens() {
    const surfaces = this.surfaces || [];
    if (!surfaces.length) return;
    const want = new Map(); // surface uuid -> session keys
    for (const [key, s] of this.sessions) {
      const uuid = s.surfaceUuid || s.focus?.cmuxShim || s.procShim;
      if (!uuid) continue;
      if (!surfaces.some((x) => x.uuid === uuid)) continue;
      if (!s.live && !s.hookDriven) continue;
      if (!want.has(uuid)) want.set(uuid, []);
      want.get(uuid).push(key);
    }
    const working = new Map();
    for (const uuid of [...want.keys()].slice(0, 12)) {
      const out = await run(CMUX_BIN, ['read-screen', '--surface', uuid, '--lines', '30']);
      if (out === null) continue; // read failed: unknown, not "idle"
      const lines = String(out).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      working.set(uuid, /esc (to )?interrupt/i.test(lines.slice(-4).join('\n')));
    }
    let changed = false;
    for (const [uuid, keys] of want) {
      if (!working.has(uuid)) continue;
      const val = working.get(uuid);
      for (const key of keys) {
        const s = this.sessions.get(key);
        if (!s || s.screenWorking === val) continue;
        // Stamp state TRANSITIONS only — turn started (…->true) or finished
        // (true->false) — so the age reads "since prompted / since finished"
        // and never ticks while running. Discovery of an already-idle tab
        // (undefined->false) keeps its on-disk age.
        const stamp = val || s.screenWorking === true;
        this.sessions.set(key, {
          ...s, screenWorking: val,
          ...(stamp ? { lastActivity: Date.now() } : {}),
        });
        // Turn finished on a session without hooks (Copilot) — hook-driven
        // sessions already fire on their Stop event.
        if (!val && s.screenWorking === true && !s.hookDriven && this.onFinished) this.onFinished(key);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // Copilot CLI only persists to its SQLite store at turn boundaries, so a
  // session mid-turn — or one that has never finished a turn — is invisible to
  // pollCopilot(). The running process is the only evidence that exists, so
  // adopt it as a session in its own right when nothing on disk matches.
  adoptAgents(agents) {
    for (const a of agents) {
      if (!a.cwd) continue;
      const known = [...this.sessions.values()].some(
        (s) => s.source === a.kind && s.cwd === a.cwd && !String(s.key).startsWith('proc:')
      );
      if (known) continue;
      const key = `proc:${a.kind}:${a.cwd}`;
      const existing = this.sessions.get(key);
      this.sessions.set(key, {
        ...existing,
        key,
        source: a.kind,
        cwd: a.cwd,
        sessionId: `pid-${a.pid}`,
        // No transcript, so no honest status claim — idle + LIVE badge. Keep
        // first-seen time; bumping it every poll made cards churn the sort.
        status: 'idle',
        hookDriven: true,           // don't let recency inference override us
        live: true,
        fromProcess: true,
        lastActivity: existing?.lastActivity || Date.now(),
      });
    }
    // Drop adopted entries whose process is gone and that never gained a
    // transcript, so stale cards don't linger.
    const alive = new Set(agents.filter((a) => a.cwd).map((a) => `proc:${a.kind}:${a.cwd}`));
    for (const key of [...this.sessions.keys()]) {
      if (String(key).startsWith('proc:') && !alive.has(key)) this.sessions.delete(key);
    }
  }

  // Ground-truth check: read every terminal surface's actual screen and set
  // it against what the cards claim. `esc to interrupt` in Claude Code's
  // status bar only renders while a turn is running, so it is a reliable
  // working marker; braille spinner glyphs cover other TUIs heuristically.
  async audit() {
    const surfaces = await this.cmuxSurfaces().catch(() => []);
    const screens = [];
    for (const x of surfaces) {
      if (x.type !== 'terminal') continue;
      const out = await run(CMUX_BIN, ['read-screen', '--surface', x.uuid, '--lines', '25']);
      const lines = String(out || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      const tail = lines.slice(-12).join('\n');
      screens.push({
        title: x.title,
        uuid: x.uuid,
        working: /esc to interrupt|[\u2800-\u28FF]/.test(tail),
        lastLine: lines[lines.length - 1] || '',
      });
    }
    const cards = this.getState().sessions.map((s) => ({
      name: s.tabTitle || s.cwd, status: s.status, live: !!s.live, source: s.source,
    }));
    return {
      screensWorking: screens.filter((x) => x.working).length,
      cardsWorking: cards.filter((c) => c.status === 'working').length,
      screens,
      cards: cards.filter((c) => c.status === 'working' || c.live),
    };
  }

  // Full re-scan: forget cached file mtimes and re-read every source.
  async refreshAll() {
    // True reset: rebuild everything from disk and live processes, so stale
    // in-memory state (e.g. activity bumped by a bad signal) cannot survive.
    this.fileCache.clear();
    this.sessions.clear();
    this.scanClaude();
    this.pollCopilot();
    await this.pollAgents().catch(() => {});
    await this.refreshCmux().catch(() => {});
    await this.pollScreens().catch(() => {});
    await this.pollPorts().catch(() => {});
    this.emit();
    return this.sessions.size;
  }

  // ---------- listening ports, attributed to sessions by cwd ----------

  async pollPorts() {
    const roots = [...this.sessions.values()].map((s) => s.cwd).filter(Boolean);
    if (!roots.length) return;
    const listeners = await listeningProcesses();

    const byKey = new Map();
    for (const l of listeners) {
      if (!l.cwd) continue;
      // Longest matching session cwd wins, so a nested repo beats its parent.
      let bestCwd = null;
      for (const [, s] of this.sessions) {
        if (!s.cwd) continue;
        if (l.cwd === s.cwd || l.cwd.startsWith(s.cwd + '/')) {
          if (!bestCwd || s.cwd.length > bestCwd.length) bestCwd = s.cwd;
        }
      }
      if (!bestCwd) continue;
      // Every session of the owning project gets the chip — pinning it to a
      // single session left the visible card portless when several sessions
      // share a cwd.
      for (const [key, s] of this.sessions) {
        if (s.cwd !== bestCwd) continue;
        const arr = byKey.get(key) || [];
        if (!arr.some((p) => p.port === l.port)) arr.push({ port: l.port, cmd: l.cmd });
        byKey.set(key, arr);
      }
    }

    let changed = false;
    for (const [key, s] of this.sessions) {
      const ports = (byKey.get(key) || []).sort((a, b) => a.port - b.port);
      const before = JSON.stringify(s.ports || []);
      const after = JSON.stringify(ports);
      if (before !== after) {
        this.sessions.set(key, { ...s, ports });
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  handleHookEvent(ev) {
    const id = ev.session_id;
    if (!id) return;
    const key = `claude:${id}`;
    const now = Date.now();
    const base = {
      source: 'claude',
      sessionId: id,
      hookDriven: true,
      lastActivity: now,
    };
    if (ev.cwd) base.cwd = ev.cwd;

    switch (ev.hook_event_name) {
      case 'SessionStart':
        this.upsert(key, { ...base, status: 'idle' });
        break;
      case 'UserPromptSubmit':
        this.upsert(key, { ...base, status: 'working', lastPrompt: clean(ev.prompt), note: null });
        break;
      case 'PermissionRequest':
        this.upsert(key, { ...base, status: 'needs-input', note: ev.tool_name ? `permission: ${ev.tool_name}` : 'permission needed' });
        break;
      case 'Notification':
        this.upsert(key, { ...base, status: 'needs-input', note: clean(ev.message) || 'waiting for input' });
        break;
      case 'Stop':
        this.upsert(key, { ...base, status: 'idle', note: null });
        if (this.onFinished) this.onFinished(key);
        if (ev.transcript_path) {
          this.enrichFromTranscript(key, ev.transcript_path);
        }
        break;
      case 'SessionEnd':
        this.upsert(key, { ...base, status: 'ended' });
        break;
      default:
        this.upsert(key, base);
    }
    this.emit();
  }

  enrichFromTranscript(key, transcriptPath) {
    try {
      const info = parseTranscriptTail(transcriptPath);
      const fields = {};
      if (info.lastReply) fields.lastReply = info.lastReply;
      if (info.summary) fields.summary = info.summary;
      if (info.branch) fields.branch = info.branch;
      if (info.cwd) fields.cwd = info.cwd;
      if (!this.sessions.get(key)?.lastPrompt && info.lastPrompt) fields.lastPrompt = info.lastPrompt;
      this.upsert(key, fields);
    } catch { /* transcript may be mid-write */ }
  }

  // ---------- Claude Code: transcript scan (backfill + fallback) ----------

  scanClaude() {
    let changed = false;
    let dirs = [];
    try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return; }
    const now = Date.now();
    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS, dir);
      let files = [];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dirPath, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (now - st.mtimeMs > MAX_AGE_MS) continue;
        if (this.fileCache.get(fp) === st.mtimeMs) continue;
        this.fileCache.set(fp, st.mtimeMs);

        const sessionId = f.replace(/\.jsonl$/, '');
        const key = `claude:${sessionId}`;
        let info;
        try { info = parseTranscriptTail(fp); } catch { continue; }
        if (!info.cwd && !info.lastPrompt) continue;

        const existing = this.sessions.get(key);
        const fields = {
          source: 'claude',
          sessionId,
          birth: st.birthtimeMs,
          // Hook-driven sessions are stamped at prompt/finish by the hooks;
          // letting transcript mtime creep the time forward mid-turn made
          // cards tick and reorder while working.
          lastActivity: existing?.hookDriven
            ? (existing.lastActivity || st.mtimeMs)
            : Math.max(st.mtimeMs, existing?.lastActivity || 0),
        };
        if (!existing?.focus && this.persistedFocus[sessionId]) {
          const { ts, ...f } = this.persistedFocus[sessionId];
          fields.focus = f;
        }
        if (info.cwd) fields.cwd = info.cwd;
        if (info.branch) fields.branch = info.branch;
        if (info.summary) fields.summary = info.summary;
        if (info.lastReply) fields.lastReply = info.lastReply;
        if (info.lastPrompt && (!existing?.hookDriven || !existing?.lastPrompt)) fields.lastPrompt = info.lastPrompt;
        this.upsert(key, fields);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // ---------- Copilot CLI: SQLite polling ----------

  pollCopilot() {
    if (!fs.existsSync(COPILOT_DB)) return;
    const sql = `
      SELECT s.id, s.cwd, s.branch, s.summary, s.updated_at,
             (SELECT MAX(t.timestamp) FROM turns t WHERE t.session_id = s.id) AS last_turn_at,
             (SELECT substr(t.user_message,1,300) FROM turns t WHERE t.session_id = s.id ORDER BY t.turn_index DESC LIMIT 1) AS last_user,
             (SELECT substr(t.assistant_response,1,400) FROM turns t WHERE t.session_id = s.id ORDER BY t.turn_index DESC LIMIT 1) AS last_assistant
      FROM sessions s
      WHERE s.updated_at > datetime('now', '-1 day')
      ORDER BY s.updated_at DESC LIMIT 25`;
    this.sqliteJson(sql, (rows) => {
      let changed = false;
      for (const r of rows) {
        const key = `copilot:${r.id}`;
        const dbLast = Date.parse(r.updated_at + 'Z') || Date.parse(r.updated_at) || Date.now();
        const existing = this.sessions.get(key);
        // Skip on the DB's own timestamp — comparing against lastActivity
        // would re-upsert forever once a screen-working bump moved it ahead,
        // and the write would drag the card back to the stale DB time.
        if (existing && existing.dbLast === dbLast) continue;
        const meta = copilotSessionMeta(r.id);
        const lastPrompt = cleanPrompt(r.last_user);
        const lastReply = clean(r.last_assistant);
        const summary = clean(r.summary);
        // The desktop app bulk-touches updated_at on launch without any new
        // turn content — that is not activity, or dozens of untouched
        // sessions surge to the top as "just active".
        const contentSame = existing
          && existing.lastPrompt === lastPrompt
          && existing.lastReply === lastReply
          && existing.summary === summary;
        // Activity = the last real conversation turn. updated_at is unusable:
        // the desktop app rewrites it for every session it merely loads.
        const turnAt = r.last_turn_at
          ? (Date.parse(r.last_turn_at + 'Z') || Date.parse(r.last_turn_at) || dbLast)
          : dbLast;
        this.upsert(key, {
          source: 'copilot',
          sessionId: r.id,
          cwd: r.cwd,
          branch: r.branch,
          summary,
          title: meta.title,
          client: meta.client,
          // Desktop-app / autopilot sessions run without the user touching a
          // terminal — keep them out of the main view unless truly working.
          background: !!(meta.client && !/cli/i.test(meta.client)),
          lastPrompt,
          lastReply,
          dbLast,
          lastActivity: contentSame
            ? (existing.lastActivity || turnAt)
            : Math.max(turnAt, existing?.lastActivity || 0),
        });
        changed = true;
      }
      if (changed) this.emit();
    });
  }

  sqliteJson(sql, cb) {
    const run = (args) => execFile('sqlite3', args, { timeout: 4000 }, (err, stdout) => {
      if (err) {
        if (args[0] === '-readonly') run(args.slice(1)); // older sqlite3 without -readonly
        return;
      }
      try { cb(JSON.parse(stdout || '[]')); } catch { /* ignore */ }
    });
    run(['-readonly', '-json', COPILOT_DB, sql]);
  }
}

// Agent processes attached to a terminal, keyed by tty. Lets us tell which
// cmux tabs are genuinely in use, and gives Copilot sessions (which never
// report their tty) a cwd to match on.
// ps TIME is cumulative CPU consumed: "12:34.56" or "1:02:03".
function parseCpuTime(t) {
  const parts = String(t).split(':').map(parseFloat);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function agentProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,tty=,time=,args='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const procs = [];
      const childCount = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d:.]+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, ttyRaw, cputime, args] = m;
        childCount.set(ppid, (childCount.get(ppid) || 0) + 1);
        const tty = ttyRaw.replace(/^\/dev\//, '');
        if (!/^ttys\d+$/.test(tty)) continue;
        // The agent binary itself, not shells or helpers that merely mention it.
        const kind = /(^|\/)claude(\s|$)/.test(args) ? 'claude'
          : /(^|\/)copilot(\s|$)/.test(args) ? 'copilot'
          : null;
        if (!kind) continue;
        const resume = (args.match(/--resume[= ]([0-9a-f-]{36})/) || [])[1] || null;
        procs.push({ pid, tty, kind, resume, cpuSec: parseCpuTime(cputime) });
      }
      if (!procs.length) return resolve([]);
      execFile('lsof', ['-a', '-d', 'cwd', '-p', procs.map((p) => p.pid).join(','), '-Fn'],
        { timeout: 5000 }, (e2, out2) => {
          const cwds = new Map();
          let cur = null;
          for (const line of String(out2 || '').split('\n')) {
            if (line.startsWith('p')) cur = line.slice(1);
            else if (line.startsWith('n') && cur) cwds.set(cur, line.slice(1));
          }
          for (const p of procs) {
            p.cwd = cwds.get(p.pid) || null;
            p.children = childCount.get(p.pid) || 0;
          }
          // cmux launches every tab's shell with a per-tab shim dir on PATH,
          // so each agent process's environment names its exact surface.
          execFile('ps', ['-wwE', '-p', procs.map((x) => x.pid).join(','), '-o', 'pid=,command='],
            { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (e3, out3) => {
              const shims = new Map();
              for (const line of String(out3 || '').split('\n')) {
                const pm = line.match(/^\s*(\d+)\s/);
                const sm = line.match(/cmux-cli-shims\/([0-9A-Fa-f-]{36})/);
                if (pm && sm) shims.set(pm[1], sm[1]);
              }
              execFile('ps', ['-p', procs.map((x) => x.pid).join(','), '-o', 'pid=,etime='],
                { timeout: 5000 }, (e4, out4) => {
                  const started = new Map();
                  for (const line of String(out4 || '').split('\n')) {
                    const m2 = line.match(/^\s*(\d+)\s+(\S+)/);
                    if (!m2) continue;
                    // etime: [[dd-]hh:]mm:ss
                    const t = m2[2]; let sec = 0;
                    const dd = t.match(/^(\d+)-(.*)$/);
                    const rest = dd ? dd[2] : t;
                    for (const v of rest.split(':')) sec = sec * 60 + parseFloat(v);
                    if (dd) sec += parseInt(dd[1], 10) * 86400;
                    started.set(m2[1], Date.now() - sec * 1000);
                  }
                  for (const p of procs) {
                    p.shim = shims.get(p.pid) || null;
                    p.startedAt = started.get(p.pid) || null;
                  }
                  resolve(procs);
                });
            });
        });
    });
  });
}

// cmux puts a per-tab shim dir on $PATH named after that tab's surface UUID:
//   /var/folders/.../cmux-cli-shims/29BD329A-E396-46B2-85FB-F60522A2ECFA
function shimSurfaceId(pathEnv) {
  if (!pathEnv) return null;
  const m = String(pathEnv).match(/cmux-cli-shims\/([0-9A-Fa-f-]{36})/);
  return m ? m[1] : null;
}

// Every process LISTENing on TCP, with its cwd (used to attribute the port to
// a session) and command name. Dev servers detach from the tty, so cwd is the
// only reliable link back to the project.
function listeningProcesses() {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const byPid = new Map();
      for (const line of String(stdout).split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 9) continue;
        const pid = f[1];
        const port = parseInt(String(f[8]).split(':').pop(), 10);
        if (!pid || !Number.isFinite(port)) continue;
        const entry = byPid.get(pid) || { pid, cmd: f[0], ports: new Set() };
        entry.ports.add(port);
        byPid.set(pid, entry);
      }
      const pids = [...byPid.keys()];
      if (!pids.length) return resolve([]);
      // One batched lsof for all cwds rather than one call per pid.
      execFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], { timeout: 5000 }, (e2, out2) => {
        const cwds = new Map();
        let cur = null;
        for (const line of String(out2 || '').split('\n')) {
          if (line.startsWith('p')) cur = line.slice(1);
          else if (line.startsWith('n') && cur) cwds.set(cur, line.slice(1));
        }
        const rows = [];
        for (const e of byPid.values()) {
          const cwd = cwds.get(e.pid) || null;
          for (const port of e.ports) rows.push({ pid: e.pid, port, cmd: e.cmd, cwd });
        }
        resolve(rows);
      });
    });
  });
}

// Chat title + client type live in the per-session workspace.yaml
function copilotSessionMeta(id) {
  try {
    const y = fs.readFileSync(path.join(os.homedir(), '.copilot', 'session-state', id, 'workspace.yaml'), 'utf8');
    return {
      title: (y.match(/^name: (.+)$/m) || [])[1] || null,
      client: (y.match(/^client_name: (.+)$/m) || [])[1] || null,
    };
  } catch { return {}; }
}

// Best-effort: match a session to a cmux surface by title/project name
function matchSurfaceByTitle(surfaces, s) {
  if (!surfaces.length) return null;
  const needles = [];
  if (s.title) needles.push(s.title.toLowerCase().slice(0, 50));
  if (s.summary) needles.push(s.summary.toLowerCase().slice(0, 40));
  if (s.lastPrompt) needles.push(s.lastPrompt.toLowerCase().slice(0, 40));
  for (const n of needles) {
    const hit = surfaces.find((x) => n.length > 8 && x.match.includes(n));
    if (hit) return hit;
  }
  // `pop()` is undefined for cwd "/" — guard before folding case.
  const proj = (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : '')?.toLowerCase() || null;
  if (proj) {
    // Segment-exact: cwd ~/Developer must match "~/developer", NOT every
    // "~/developer/<repo>" tab (that substring bug pinned a session to four
    // bare shells titled ~/Developer/vulnerability-aggregator).
    const hit = surfaces.find((x) => x.match === proj || x.match.endsWith('/' + proj));
    if (hit) return hit;
  }
  return null;
}

// ---------- transcript parsing helpers ----------

function parseTranscriptTail(fp) {
  const st = fs.statSync(fp);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(fp, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);

  const info = {};
  const lines = buf.toString('utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let l;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.cwd) info.cwd = l.cwd;
    if (l.gitBranch) info.branch = l.gitBranch;
    if (l.type === 'summary' && l.summary) info.summary = l.summary;
    if (l.type === 'user' && !l.isMeta) {
      const text = extractText(l.message?.content);
      if (text && !text.startsWith('<')) info.lastPrompt = text;
    }
    if (l.type === 'assistant') {
      const text = extractText(l.message?.content);
      if (text) info.lastReply = text;
    }
  }
  return info;
}

function extractText(content) {
  if (typeof content === 'string') return clean(content);
  if (Array.isArray(content)) {
    const parts = content.filter((p) => p.type === 'text' && p.text).map((p) => p.text);
    return clean(parts.join(' '));
  }
  return null;
}

function cleanPrompt(s) {
  const t = clean(s);
  return t && t.startsWith('<') ? null : t;
}

function clean(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 400 ? t.slice(0, 400) + '…' : t || null;
}

module.exports = { Collector };
