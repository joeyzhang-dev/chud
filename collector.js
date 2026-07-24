const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = 4471;
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
      if (req.method === 'POST' && req.url === '/event') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { this.handleHookEvent(JSON.parse(body)); } catch { /* ignore malformed */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
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
          lastPrompt: clean(r.last_user),
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

function clean(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 400 ? t.slice(0, 400) + '…' : t || null;
}

module.exports = { Collector };
