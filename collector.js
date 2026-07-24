const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = 4471;
const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, env: { ...process.env, CMUX_QUIET: '1' } }, (err, stdout) => {
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
    setInterval(() => this.scanClaude(), 5000);
    setInterval(() => this.pollCopilot(), 5000);
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
    const existing = this.sessions.get(key) || {};
    this.sessions.set(key, { ...existing, key, focus: { ...existing.focus, ...focus } });
  }

  // Bring the terminal/app hosting this session to the front
  async focusSession(key) {
    const s = this.sessions.get(key);
    if (!s) return 'unknown session';

    // 1. Precise: cmux surface captured from the session's environment
    if (s.focus?.cmuxSurface) {
      await run(CMUX_BIN, ['focus-panel', '--panel', s.focus.cmuxSurface]);
      await run('open', ['-b', 'com.cmuxterm.app']);
      run(CMUX_BIN, ['trigger-flash', '--surface', s.focus.cmuxSurface]);
      return 'focused cmux surface';
    }

    // 2. Best effort: find a cmux surface whose title matches this session
    const surface = await this.findCmuxSurface(s);
    if (surface) {
      await run(CMUX_BIN, ['focus-panel', '--panel', surface]);
      await run('open', ['-b', 'com.cmuxterm.app']);
      run(CMUX_BIN, ['trigger-flash', '--surface', surface]);
      return 'focused cmux surface (title match)';
    }

    // 3. Fallback: just activate the hosting app
    if (s.focus?.bundle) {
      await run('open', ['-b', s.focus.bundle]);
      return 'activated app ' + s.focus.bundle;
    }
    await run('open', ['-b', 'com.cmuxterm.app']);
    return 'activated cmux (no precise match)';
  }

  async findCmuxSurface(s) {
    const out = await run(CMUX_BIN, ['tree', '--all', '--id-format', 'both']);
    if (!out) return null;
    // lines like: surface surface:5 (UUID) [terminal] "Title ..." tty=ttys001
    const surfaces = [];
    for (const line of out.split('\n')) {
      const m = line.match(/surface surface:\d+\s+([0-9A-Fa-f-]{36})\s+\[terminal\]\s+"([^"]*)"/);
      if (m) surfaces.push({ uuid: m[1], title: m[2].toLowerCase() });
    }
    if (!surfaces.length) return null;

    const needles = [];
    if (s.summary) needles.push(s.summary.toLowerCase().slice(0, 40));
    if (s.lastPrompt) needles.push(s.lastPrompt.toLowerCase().slice(0, 40));
    const proj = s.cwd ? s.cwd.split('/').filter(Boolean).pop().toLowerCase() : null;

    for (const n of needles) {
      const hit = surfaces.find((x) => n.length > 8 && x.title.includes(n));
      if (hit) return hit.uuid;
    }
    if (proj) {
      const hit = surfaces.find((x) => x.title.includes('/' + proj) || x.title.endsWith(proj));
      if (hit) return hit.uuid;
    }
    return null;
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
        this.upsert(key, {
          source: 'copilot',
          sessionId: r.id,
          cwd: r.cwd,
          branch: r.branch,
          summary: clean(r.summary),
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
