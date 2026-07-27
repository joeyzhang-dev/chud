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
  }

  start() {
    this.startServer();
    this.scanClaude();
    this.pollCopilot();
    this.refreshCmux();
    this.pollPorts();
    setInterval(() => this.scanClaude(), 5000);
    setInterval(() => this.pollCopilot(), 5000);
    setInterval(() => this.refreshCmux(), 4000);
    setInterval(() => this.pollPorts(), 5000);
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
    list.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lastActivity - a.lastActivity));
    return { sessions: list, updatedAt: now };
  }

  effectiveStatus(s, now) {
    let status = s.status;
    if (!s.hookDriven) {
      // Inferred purely from file/db recency
      status = now - s.lastActivity < 90000 ? 'working' : 'idle';
    }
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
    this.sessions.set(key, { ...existing, key, focus: { ...existing.focus, ...focus } });
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
    const surfaces = await this.cmuxSurfaces();
    const target = this.resolveSurface(s, surfaces);

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
    const byUuid = (id) => (id ? term.find((x) => x.uuid.toLowerCase() === String(id).toLowerCase()) : null);
    // NOTE: do NOT match on tty. The `tty=` field in `cmux tree` goes stale
    // after agent-resume/hibernation — a surface keeps reporting the pty it
    // was first created with, so it can name a tab the session doesn't occupy.
    // The $PATH shim dir is the surface UUID cmux assigned this tab and has
    // proven accurate (verified against `cmux read-screen`).
    return (
      byUuid(s.focus?.cmuxSurface) ||   // explicit env var (usually unset)
      byUuid(s.focus?.cmuxShim) ||      // $PATH shim dir — the reliable signal
      matchSurfaceByTitle(term, s) ||   // title/cwd heuristic
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

    // Liveness is computed from running agent processes by cwd, deliberately
    // WITHOUT going through surfaces: the tty->surface mapping is unreliable
    // (see resolveSurface), and "is an agent running in this project right
    // now" is the thing we actually care about for the default view.
    const agents = await ttyAgents().catch(() => new Map());
    const liveCwds = new Set();
    for (const a of agents.values()) if (a.cwd) liveCwds.add(`${a.kind} ${a.cwd}`);

    const claimed = new Set();   // surface uuids already assigned
    const assign = new Map();    // session key -> surface

    // One session per tab: strongest identity wins the claim.
    for (const [key, s] of this.sessions) {
      let hit = null;
      try { hit = this.resolveSurface(s, surfaces); } catch { /* skip */ }
      if (hit && !claimed.has(hit.uuid)) {
        claimed.add(hit.uuid);
        assign.set(key, hit);
      }
    }

    // Among sessions sharing a cwd, only the most recent counts as live, so a
    // project with eight historical sessions yields one card, not eight.
    const newestPerCwd = new Map();
    for (const [key, s] of this.sessions) {
      if (!s.cwd || !s.source) continue;
      const k = `${s.source} ${s.cwd}`;
      if (!liveCwds.has(k)) continue;
      const prev = newestPerCwd.get(k);
      if (!prev || s.lastActivity > prev.lastActivity) newestPerCwd.set(k, { key, lastActivity: s.lastActivity });
    }
    const liveKeys = new Set([...newestPerCwd.values()].map((v) => v.key));

    let changed = false;
    for (const [key, s] of this.sessions) {
      const hit = assign.get(key) || null;
      const tab = hit ? hit.title : null;
      const ws = hit ? hit.workspaceTitle : null;
      const siblings = hit ? hit.paneTabs : 0;
      const live = liveKeys.has(key);
      if (s.tabTitle !== tab || s.workspaceTitle !== ws || s.paneTabs !== siblings || s.live !== live) {
        this.sessions.set(key, {
          ...s, tabTitle: tab, workspaceTitle: ws, paneTabs: siblings, cmux: !!hit, live,
        });
        changed = true;
      }
    }
    if (changed) this.emit();
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
      let best = null;
      for (const [key, s] of this.sessions) {
        if (!s.cwd) continue;
        if (l.cwd === s.cwd || l.cwd.startsWith(s.cwd + '/')) {
          if (!best || s.cwd.length > best.cwd.length) best = { key, cwd: s.cwd };
        }
      }
      if (!best) continue;
      const arr = byKey.get(best.key) || [];
      if (!arr.some((p) => p.port === l.port)) arr.push({ port: l.port, cmd: l.cmd });
      byKey.set(best.key, arr);
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
          lastActivity: Math.max(st.mtimeMs, existing?.lastActivity || 0),
        };
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
             (SELECT substr(t.user_message,1,300) FROM turns t WHERE t.session_id = s.id ORDER BY t.turn_index DESC LIMIT 1) AS last_user,
             (SELECT substr(t.assistant_response,1,400) FROM turns t WHERE t.session_id = s.id ORDER BY t.turn_index DESC LIMIT 1) AS last_assistant
      FROM sessions s
      WHERE s.updated_at > datetime('now', '-1 day')
      ORDER BY s.updated_at DESC LIMIT 25`;
    this.sqliteJson(sql, (rows) => {
      let changed = false;
      for (const r of rows) {
        const key = `copilot:${r.id}`;
        const lastActivity = Date.parse(r.updated_at + 'Z') || Date.parse(r.updated_at) || Date.now();
        const existing = this.sessions.get(key);
        if (existing && existing.lastActivity === lastActivity) continue;
        const meta = copilotSessionMeta(r.id);
        this.upsert(key, {
          source: 'copilot',
          sessionId: r.id,
          cwd: r.cwd,
          branch: r.branch,
          summary: clean(r.summary),
          title: meta.title,
          client: meta.client,
          lastPrompt: cleanPrompt(r.last_user),
          lastReply: clean(r.last_assistant),
          lastActivity,
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
function ttyAgents() {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,tty=,args='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(new Map());
      const found = new Map(); // tty -> {pid, kind}
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ttyRaw, args] = m;
        const tty = ttyRaw.replace(/^\/dev\//, '');
        if (!/^ttys\d+$/.test(tty)) continue;
        // The agent binary itself, not shells or helpers that merely mention it.
        const kind = /(^|\/)claude(\s|$)/.test(args) ? 'claude'
          : /(^|\/)copilot(\s|$)/.test(args) ? 'copilot'
          : null;
        if (!kind) continue;
        if (!found.has(tty)) found.set(tty, { pid, kind });
      }
      const pids = [...found.values()].map((v) => v.pid);
      if (!pids.length) return resolve(found);
      execFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], { timeout: 5000 }, (e2, out2) => {
        const cwds = new Map();
        let cur = null;
        for (const line of String(out2 || '').split('\n')) {
          if (line.startsWith('p')) cur = line.slice(1);
          else if (line.startsWith('n') && cur) cwds.set(cur, line.slice(1));
        }
        for (const v of found.values()) v.cwd = cwds.get(v.pid) || null;
        resolve(found);
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
    const hit = surfaces.find((x) => x.match.includes('/' + proj) || x.match.endsWith(proj));
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
