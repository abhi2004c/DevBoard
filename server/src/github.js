import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { signToken, verifyToken, requireRole } from './auth.js';
import { emitToWorkspace } from './realtime.js';

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
// Public URL (e.g. an ngrok tunnel) so GitHub can reach /api/github/webhook.
const WEBHOOK_BASE = process.env.WEBHOOK_URL || '';
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function gh(token, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DevBoard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `GitHub error ${res.status}`), { status: res.status });
  return data;
}

async function activity(wid, projectId, userId, summary, entity = 'github', entityId = null) {
  const { rows } = await query(
    `INSERT INTO activity_log (workspace_id,project_id,user_id,action,entity,entity_id,summary)
     VALUES ($1,$2,$3,'github',$4,$5,$6)
     RETURNING *, (SELECT name FROM users WHERE id=$3) AS user_name`,
    [wid, projectId, userId, entity, entityId, summary]);
  emitToWorkspace(wid, 'activity:new', rows[0]);
}

// Pending invites (by GitHub login) become memberships when that person connects GitHub.
async function claimInvites(user) {
  if (!user.github_login) return;
  const { rows } = await query(
    'DELETE FROM workspace_invites WHERE lower(github_login)=lower($1) RETURNING workspace_id, role', [user.github_login]);
  for (const i of rows) {
    await query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [i.workspace_id, user.id, i.role]);
    emitToWorkspace(i.workspace_id, 'members:changed', {});
  }
}

// ---------------- OAuth + webhook (public) ----------------
export const publicRouter = Router();

publicRouter.get('/auth/github', (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID) {
    return res.status(501).send('GitHub OAuth is not configured on the server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).');
  }
  let linkUid = null; // set when an already-logged-in user connects GitHub
  try { if (req.query.token) linkUid = verifyToken(req.query.token).uid; } catch { /* ignore */ }
  // desktop=1: finish by redirecting to the devboard:// protocol so the Electron app receives the token.
  const state = jwt.sign({ linkUid, desktop: req.query.desktop === '1', n: crypto.randomUUID() }, SECRET, { expiresIn: '10m' });
  const p = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/auth/github/callback`,
    scope: 'read:user user:email repo admin:repo_hook',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${p}`);
});

publicRouter.get('/auth/github/callback', wrap(async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state), SECRET); } catch { return res.redirect(`${APP_URL}/?error=Invalid%20OAuth%20state`); }
  const dest = (q) => (st.desktop ? `devboard://auth?${q}` : `${APP_URL}/?${q}`);
  const fail = (m) => res.redirect(dest(`error=${encodeURIComponent(m)}`));
  if (!req.query.code) return fail('GitHub authorization was denied');

  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: req.query.code,
      redirect_uri: `${APP_URL}/api/auth/github/callback`,
    }),
  }).then((r) => r.json());
  if (!tokRes.access_token) return fail(tokRes.error_description || 'GitHub token exchange failed');
  const token = tokRes.access_token;

  const gu = await gh(token, '/user');
  let email = gu.email;
  if (!email) {
    const emails = await gh(token, '/user/emails').catch(() => []);
    email = (emails.find((e) => e.primary && e.verified) || emails[0])?.email;
  }
  email = (email || `${gu.login}@users.noreply.github.com`).toLowerCase();

  const attach = (id) => query(
    'UPDATE users SET github_id=$1, github_login=$2, github_token=$3, avatar_url=$4 WHERE id=$5 RETURNING *',
    [gu.id, gu.login, token, gu.avatar_url, id]).then((r) => r.rows[0]);

  let user;
  if (st.linkUid) {
    const taken = (await query('SELECT id FROM users WHERE github_id=$1 AND id<>$2', [gu.id, st.linkUid])).rows[0];
    if (taken) return fail('That GitHub account is already linked to another DevBoard user');
    user = await attach(st.linkUid);
  } else {
    user = (await query('SELECT * FROM users WHERE github_id=$1', [gu.id])).rows[0]
      || (await query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    if (user) user = await attach(user.id);
    else {
      user = (await query(
        `INSERT INTO users (email,name,github_id,github_login,github_token,avatar_url)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [email, gu.name || gu.login, gu.id, gu.login, token, gu.avatar_url])).rows[0];
    }
  }
  if (!user) return fail('Could not link GitHub account');
  await claimInvites(user);
  res.redirect(dest(`token=${signToken(user)}`));
}));

const KEY_RE = /\b([A-Z]{2,6})-(\d+)\b/g;
const keysIn = (text) => [...new Set([...text.matchAll(KEY_RE)].map((x) => `${x[1]}-${x[2]}`))];

async function linkTask(repo, ref, link, newStatus) {
  const [key, n] = ref.split('-');
  const t = (await query(
    `SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.key=$2 AND t.project_id=$3`, [Number(n), key, repo.project_id])).rows[0];
  if (!t) return;
  await query(
    `INSERT INTO task_links (task_id,kind,ref,title,url,state) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (task_id,kind,ref) DO UPDATE SET title=EXCLUDED.title, state=EXCLUDED.state`,
    [t.id, link.kind, link.ref, link.title, link.url, link.state]);
  const moved = newStatus && t.status !== newStatus;
  if (moved) await query('UPDATE tasks SET status=$1, updated_at=now() WHERE id=$2', [newStatus, t.id]);
  emitToWorkspace(repo.workspace_id, 'tasks:changed', { projectId: repo.project_id });
  await activity(repo.workspace_id, repo.project_id, null,
    `GitHub ${link.kind} "${link.title}" linked to ${ref}${moved ? ` → ${newStatus}` : ''}`, 'task', t.id);
}

publicRouter.post('/github/webhook/:rid', wrap(async (req, res) => {
  const repo = (await query('SELECT * FROM github_repos WHERE id=$1', [Number(req.params.rid)])).rows[0];
  if (!repo) return res.sendStatus(404);
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const expect = 'sha256=' + crypto.createHmac('sha256', repo.webhook_secret).update(req.rawBody || '').digest('hex');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return res.sendStatus(401);

  const ev = req.headers['x-github-event'];
  const b = req.body;
  if (ev === 'pull_request') {
    const pr = b.pull_request;
    const state = pr.merged ? 'merged' : pr.state;
    const status = pr.merged ? 'done' : pr.state === 'open' ? 'review' : null;
    for (const ref of keysIn(`${pr.title} ${pr.head?.ref || ''} ${pr.body || ''}`)) {
      await linkTask(repo, ref, { kind: 'pr', ref: String(pr.number), title: `#${pr.number} ${pr.title}`, url: pr.html_url, state }, status);
    }
  } else if (ev === 'push') {
    for (const c of b.commits || []) {
      for (const ref of keysIn(c.message)) {
        await linkTask(repo, ref, { kind: 'commit', ref: c.id.slice(0, 7), title: `${c.id.slice(0, 7)} ${c.message.split('\n')[0]}`, url: c.url, state: null }, null);
      }
    }
  }
  res.sendStatus(204);
}));

// ---------------- Workspace-scoped (mounted at /workspaces/:wid/github) ----------------
export const wsRouter = Router({ mergeParams: true });

async function myToken(req, res) {
  const u = (await query('SELECT github_token FROM users WHERE id=$1', [req.userId])).rows[0];
  if (!u?.github_token) { res.status(409).json({ error: 'Connect your GitHub account first' }); return null; }
  return u.github_token;
}
const ghErr = (res, e) => res.status(e.status === 404 ? 404 : e.status === 401 ? 409 : 502).json({ error: e.message });

wsRouter.get('/status', wrap(async (req, res) => {
  const u = (await query('SELECT github_login, avatar_url FROM users WHERE id=$1', [req.userId])).rows[0];
  const repos = (await query('SELECT project_id, full_name FROM github_repos WHERE workspace_id=$1', [req.wid])).rows;
  res.json({
    connected: !!u?.github_login, login: u?.github_login, avatar: u?.avatar_url, repos,
    webhooks: !!WEBHOOK_BASE, oauth: !!process.env.GITHUB_CLIENT_ID,
  });
}));

wsRouter.get('/repos', requireRole('admin'), wrap(async (req, res) => {
  const token = await myToken(req, res); if (!token) return;
  try {
    const repos = await gh(token, '/user/repos?per_page=100&sort=pushed');
    res.json(repos.map((r) => ({ full_name: r.full_name, private: r.private })));
  } catch (e) { ghErr(res, e); }
}));

wsRouter.post('/link', requireRole('admin'), wrap(async (req, res) => {
  const { project_id, full_name } = req.body || {};
  if (!/^[\w.-]+\/[\w.-]+$/.test(full_name || '')) return res.status(400).json({ error: 'invalid repo' });
  const proj = (await query('SELECT id FROM projects WHERE id=$1 AND workspace_id=$2', [Number(project_id), req.wid])).rows[0];
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const token = await myToken(req, res); if (!token) return;
  try { await gh(token, `/repos/${full_name}`); } catch (e) { return ghErr(res, e); }

  const secret = crypto.randomBytes(20).toString('hex');
  const { rows } = await query(
    `INSERT INTO github_repos (workspace_id,project_id,full_name,webhook_secret,linked_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id) DO UPDATE SET full_name=EXCLUDED.full_name, webhook_secret=EXCLUDED.webhook_secret, linked_by=EXCLUDED.linked_by
     RETURNING *`, [req.wid, proj.id, full_name, secret, req.userId]);
  let webhook = 'skipped (set WEBHOOK_URL to a public URL to enable PR/commit linking)';
  if (WEBHOOK_BASE) {
    try {
      const hook = await gh(token, `/repos/${full_name}/hooks`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'web', active: true, events: ['pull_request', 'push'],
          config: { url: `${WEBHOOK_BASE}/api/github/webhook/${rows[0].id}`, content_type: 'json', secret },
        }),
      });
      await query('UPDATE github_repos SET webhook_id=$1 WHERE id=$2', [hook.id, rows[0].id]);
      webhook = 'created';
    } catch (e) { webhook = `failed: ${e.message} (admin rights on the repo are required)`; }
  }
  await activity(req.wid, proj.id, req.userId, `linked repository ${full_name}`);
  res.status(201).json({ full_name, webhook });
}));

wsRouter.delete('/link/:pid', requireRole('admin'), wrap(async (req, res) => {
  const repo = (await query('DELETE FROM github_repos WHERE project_id=$1 AND workspace_id=$2 RETURNING *',
    [Number(req.params.pid), req.wid])).rows[0];
  if (!repo) return res.status(404).json({ error: 'Not linked' });
  const token = (await query('SELECT github_token FROM users WHERE id=$1', [req.userId])).rows[0]?.github_token;
  if (token && repo.webhook_id) await gh(token, `/repos/${repo.full_name}/hooks/${repo.webhook_id}`, { method: 'DELETE' }).catch(() => {});
  res.json({ ok: true });
}));

async function linkedRepo(req, res) {
  const repo = (await query('SELECT * FROM github_repos WHERE project_id=$1 AND workspace_id=$2',
    [Number(req.params.pid), req.wid])).rows[0];
  if (!repo) res.status(404).json({ error: 'No repository linked to this project' });
  return repo;
}

// Collaborators of the linked repo, annotated with their DevBoard status.
wsRouter.get('/projects/:pid/collaborators', wrap(async (req, res) => {
  const repo = await linkedRepo(req, res); if (!repo) return;
  const token = await myToken(req, res); if (!token) return;
  try {
    const collabs = await gh(token, `/repos/${repo.full_name}/collaborators?per_page=100`);
    const users = (await query(
      `SELECT lower(u.github_login) AS login, m.role FROM users u
       LEFT JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$2
       WHERE lower(u.github_login) = ANY($1)`, [collabs.map((c) => c.login.toLowerCase()), req.wid])).rows;
    const invites = (await query('SELECT lower(github_login) AS login, role FROM workspace_invites WHERE workspace_id=$1', [req.wid])).rows;
    res.json(collabs.map((c) => {
      const l = c.login.toLowerCase();
      const u = users.find((x) => x.login === l);
      const inv = invites.find((x) => x.login === l);
      return {
        login: c.login, avatar: c.avatar_url, url: c.html_url,
        state: u?.role ? 'member' : inv ? 'invited' : u ? 'on_devboard' : 'not_on_devboard',
        role: u?.role || inv?.role || null,
      };
    }));
  } catch (e) { ghErr(res, e); }
}));

// Add a collaborator now (if they've connected GitHub) or leave a pending invite.
wsRouter.post('/invite', requireRole('admin'), wrap(async (req, res) => {
  const { login, role = 'member' } = req.body || {};
  if (!login || !['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'login and valid role required' });
  const u = (await query('SELECT id, name FROM users WHERE lower(github_login)=lower($1)', [login])).rows[0];
  if (u) {
    await query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.wid, u.id, role]);
    emitToWorkspace(req.wid, 'members:changed', {});
    await activity(req.wid, null, req.userId, `added ${u.name} (@${login}) from GitHub as ${role}`, 'member', u.id);
    return res.json({ state: 'member' });
  }
  await query(
    `INSERT INTO workspace_invites VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, github_login) DO UPDATE SET role=EXCLUDED.role`, [req.wid, login, role]);
  await activity(req.wid, null, req.userId, `invited @${login} — they join when they sign in with GitHub`);
  res.json({ state: 'invited' });
}));

wsRouter.post('/projects/:pid/import-issues', requireRole('member'), wrap(async (req, res) => {
  const repo = await linkedRepo(req, res); if (!repo) return;
  const token = await myToken(req, res); if (!token) return;
  try {
    const issues = (await gh(token, `/repos/${repo.full_name}/issues?state=open&per_page=100`)).filter((i) => !i.pull_request);
    let imported = 0;
    for (const i of issues) {
      const pos = (await query("SELECT COALESCE(MAX(position),0)+1 AS p FROM tasks WHERE project_id=$1 AND status='todo'", [repo.project_id])).rows[0].p;
      const ins = await query(
        `INSERT INTO tasks (workspace_id,project_id,title,description,created_by,position,github_issue)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [repo.workspace_id, repo.project_id, i.title.slice(0, 200), i.body || '', req.userId, pos, i.number]);
      if (ins.rowCount) {
        imported++;
        await query(
          `INSERT INTO task_links (task_id,kind,ref,title,url,state) VALUES ($1,'issue',$2,$3,$4,'open') ON CONFLICT DO NOTHING`,
          [ins.rows[0].id, String(i.number), `#${i.number} ${i.title}`, i.html_url]);
      }
    }
    emitToWorkspace(req.wid, 'tasks:changed', { projectId: repo.project_id });
    await activity(req.wid, repo.project_id, req.userId, `imported ${imported} issue(s) from ${repo.full_name}`);
    res.json({ imported, skipped: issues.length - imported });
  } catch (e) { ghErr(res, e); }
}));
