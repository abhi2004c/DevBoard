import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query, pool } from './db.js';
import { signToken, requireAuth, requireWorkspace, requireRole } from './auth.js';
import { emitToWorkspace } from './realtime.js';
import { publicRouter, wsRouter as githubWs } from './github.js';

const r = Router();
r.use(publicRouter);
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ROLES = ['admin', 'member', 'viewer'];
const bad = (res, msg) => res.status(400).json({ error: msg });

async function log(req, { projectId = null, action, entity, entityId, summary }) {
  const { rows } = await query(
    `INSERT INTO activity_log (workspace_id, project_id, user_id, action, entity, entity_id, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *, (SELECT name FROM users WHERE id=$3) AS user_name`,
    [req.wid, projectId, req.userId, action, entity, entityId, summary]
  );
  emitToWorkspace(req.wid, 'activity:new', rows[0]);
}

// ---------- Auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });
r.use(['/auth/register', '/auth/login'], authLimiter);

r.post('/auth/register', wrap(async (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !name || !password || password.length < 6) return bad(res, 'email, name and password (6+ chars) required');
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await query(
      'INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING id,email,name',
      [email.toLowerCase().trim(), name.trim(), hash]
    );
    res.status(201).json({ token: signToken(rows[0]), user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw e;
  }
}));

r.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password || '', u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(u), user: { id: u.id, email: u.email, name: u.name } });
}));

r.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await query('SELECT id,email,name FROM users WHERE id=$1', [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// ---------- Workspaces ----------
r.get('/workspaces', requireAuth, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT w.id, w.name, m.role FROM workspaces w
     JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name`,
    [req.userId]
  );
  res.json(rows);
}));

r.post('/workspaces', requireAuth, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'name required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id,name', [name]);
    await client.query("INSERT INTO memberships VALUES ($1,$2,'owner')", [rows[0].id, req.userId]);
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], role: 'owner' });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Everything below is tenant-scoped: /workspaces/:wid/...
const ws = Router({ mergeParams: true });
r.use('/workspaces/:wid', requireAuth, wrap(requireWorkspace), ws);
ws.use('/github', githubWs);

ws.get('/members', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id=m.user_id
     WHERE m.workspace_id=$1 ORDER BY u.name`, [req.wid]);
  res.json(rows);
}));

ws.post('/members', requireRole('admin'), wrap(async (req, res) => {
  const { email, role = 'member' } = req.body || {};
  if (!ROLES.includes(role)) return bad(res, 'invalid role');
  const u = (await query('SELECT id,name,email FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()])).rows[0];
  if (!u) return res.status(404).json({ error: 'No user with that email — ask them to register first' });
  const ins = await query(
    'INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id', [req.wid, u.id, role]);
  if (!ins.rowCount) return res.status(409).json({ error: 'Already a member' });
  await log(req, { action: 'added', entity: 'member', entityId: u.id, summary: `added ${u.name} as ${role}` });
  emitToWorkspace(req.wid, 'members:changed', {});
  res.status(201).json({ ...u, role });
}));

ws.patch('/members/:uid', requireRole('admin'), wrap(async (req, res) => {
  const uid = Number(req.params.uid);
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return bad(res, 'invalid role');
  const { rowCount } = await query(
    "UPDATE memberships SET role=$1 WHERE workspace_id=$2 AND user_id=$3 AND role<>'owner'", [role, req.wid, uid]);
  if (!rowCount) return res.status(404).json({ error: 'Member not found or is owner' });
  await log(req, { action: 'updated', entity: 'member', entityId: uid, summary: `changed a member's role to ${role}` });
  emitToWorkspace(req.wid, 'members:changed', {});
  res.json({ ok: true });
}));

ws.delete('/members/:uid', requireRole('admin'), wrap(async (req, res) => {
  const uid = Number(req.params.uid);
  const { rowCount } = await query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'", [req.wid, uid]);
  if (!rowCount) return res.status(404).json({ error: 'Member not found or is owner' });
  await log(req, { action: 'removed', entity: 'member', entityId: uid, summary: 'removed a member' });
  emitToWorkspace(req.wid, 'members:changed', {});
  res.json({ ok: true });
}));

// ---------- Projects ----------
ws.get('/projects', wrap(async (req, res) => {
  res.json((await query('SELECT * FROM projects WHERE workspace_id=$1 ORDER BY name', [req.wid])).rows);
}));

ws.post('/projects', requireRole('admin'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const key = String(req.body?.key || '').trim().toUpperCase();
  if (!name || !/^[A-Z]{2,6}$/.test(key)) return bad(res, 'name and a 2-6 letter key required');
  try {
    const { rows } = await query(
      'INSERT INTO projects (workspace_id,name,key) VALUES ($1,$2,$3) RETURNING *', [req.wid, name, key]);
    await log(req, { projectId: rows[0].id, action: 'created', entity: 'project', entityId: rows[0].id, summary: `created project ${name}` });
    emitToWorkspace(req.wid, 'project:created', rows[0]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Project key already used' });
    throw e;
  }
}));

// ---------- Sprints ----------
ws.get('/projects/:pid/sprints', wrap(async (req, res) => {
  res.json((await query(
    'SELECT * FROM sprints WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC',
    [req.wid, Number(req.params.pid)])).rows);
}));

ws.post('/projects/:pid/sprints', requireRole('admin'), wrap(async (req, res) => {
  const { name, goal = '', start_date = null, end_date = null } = req.body || {};
  if (!name?.trim()) return bad(res, 'name required');
  const pid = Number(req.params.pid);
  const p = (await query('SELECT id FROM projects WHERE id=$1 AND workspace_id=$2', [pid, req.wid])).rows[0];
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const { rows } = await query(
    `INSERT INTO sprints (workspace_id,project_id,name,goal,start_date,end_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.wid, pid, name.trim(), goal, start_date || null, end_date || null]);
  await log(req, { projectId: pid, action: 'created', entity: 'sprint', entityId: rows[0].id, summary: `created sprint ${name}` });
  emitToWorkspace(req.wid, 'sprint:changed', rows[0]);
  res.status(201).json(rows[0]);
}));

ws.patch('/sprints/:sid', requireRole('admin'), wrap(async (req, res) => {
  const sid = Number(req.params.sid);
  const { status } = req.body || {};
  if (!['planned', 'active', 'completed'].includes(status)) return bad(res, 'invalid status');
  const cur = (await query('SELECT * FROM sprints WHERE id=$1 AND workspace_id=$2', [sid, req.wid])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Sprint not found' });
  if (status === 'active') {
    const other = await query("SELECT 1 FROM sprints WHERE project_id=$1 AND status='active' AND id<>$2", [cur.project_id, sid]);
    if (other.rowCount) return res.status(409).json({ error: 'Another sprint is already active' });
  }
  const { rows } = await query('UPDATE sprints SET status=$1 WHERE id=$2 RETURNING *', [status, sid]);
  // Completing a sprint returns unfinished work to the backlog.
  if (status === 'completed') {
    await query("UPDATE tasks SET sprint_id=NULL WHERE sprint_id=$1 AND status<>'done'", [sid]);
    emitToWorkspace(req.wid, 'tasks:changed', { projectId: cur.project_id });
  }
  await log(req, { projectId: cur.project_id, action: 'updated', entity: 'sprint', entityId: sid, summary: `marked sprint ${cur.name} ${status}` });
  emitToWorkspace(req.wid, 'sprint:changed', rows[0]);
  res.json(rows[0]);
}));

// ---------- Tasks ----------
ws.get('/projects/:pid/tasks', wrap(async (req, res) => {
  res.json((await query(
    `SELECT t.*, u.name AS assignee_name,
       COALESCE((SELECT json_agg(json_build_object('kind',l.kind,'title',l.title,'url',l.url,'state',l.state) ORDER BY l.id)
                 FROM task_links l WHERE l.task_id=t.id), '[]') AS links
     FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
     WHERE t.workspace_id=$1 AND t.project_id=$2 ORDER BY t.position, t.id`,
    [req.wid, Number(req.params.pid)])).rows);
}));

async function taskWithAssignee(id) {
  return (await query(
    `SELECT t.*, u.name AS assignee_name,
       COALESCE((SELECT json_agg(json_build_object('kind',l.kind,'title',l.title,'url',l.url,'state',l.state) ORDER BY l.id)
                 FROM task_links l WHERE l.task_id=t.id), '[]') AS links
     FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=$1`, [id])).rows[0];
}

// Ensures referenced sprint/assignee belong to this tenant.
async function validateRefs(req, projectId, { sprint_id, assignee_id }) {
  if (sprint_id) {
    const ok = await query('SELECT 1 FROM sprints WHERE id=$1 AND workspace_id=$2 AND project_id=$3', [sprint_id, req.wid, projectId]);
    if (!ok.rowCount) return 'Sprint not in this project';
  }
  if (assignee_id) {
    const ok = await query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [req.wid, assignee_id]);
    if (!ok.rowCount) return 'Assignee is not a workspace member';
  }
  return null;
}

ws.post('/projects/:pid/tasks', requireRole('member'), wrap(async (req, res) => {
  const pid = Number(req.params.pid);
  const { title, description = '', priority = 'medium', status = 'todo', points = null, sprint_id = null, assignee_id = null } = req.body || {};
  if (!title?.trim()) return bad(res, 'title required');
  if (!PRIORITIES.includes(priority) || !STATUSES.includes(status)) return bad(res, 'invalid status/priority');
  const p = (await query('SELECT id FROM projects WHERE id=$1 AND workspace_id=$2', [pid, req.wid])).rows[0];
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const err = await validateRefs(req, pid, { sprint_id, assignee_id });
  if (err) return bad(res, err);
  const pos = (await query('SELECT COALESCE(MAX(position),0)+1 AS p FROM tasks WHERE project_id=$1 AND status=$2', [pid, status])).rows[0].p;
  const ins = await query(
    `INSERT INTO tasks (workspace_id,project_id,sprint_id,title,description,status,priority,points,assignee_id,created_by,position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.wid, pid, sprint_id, title.trim(), description, status, priority, points, assignee_id, req.userId, pos]);
  const task = await taskWithAssignee(ins.rows[0].id);
  await log(req, { projectId: pid, action: 'created', entity: 'task', entityId: task.id, summary: `created task "${task.title}"` });
  emitToWorkspace(req.wid, 'task:created', task);
  res.status(201).json(task);
}));

ws.patch('/tasks/:tid', requireRole('member'), wrap(async (req, res) => {
  const tid = Number(req.params.tid);
  const cur = (await query('SELECT * FROM tasks WHERE id=$1 AND workspace_id=$2', [tid, req.wid])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Task not found' });
  const allowed = ['title', 'description', 'status', 'priority', 'points', 'sprint_id', 'assignee_id', 'position'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (patch.status && !STATUSES.includes(patch.status)) return bad(res, 'invalid status');
  if (patch.priority && !PRIORITIES.includes(patch.priority)) return bad(res, 'invalid priority');
  if (patch.title !== undefined && !String(patch.title).trim()) return bad(res, 'title required');
  const err = await validateRefs(req, cur.project_id, patch);
  if (err) return bad(res, err);
  const keys = Object.keys(patch);
  if (!keys.length) return bad(res, 'nothing to update');
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  await query(`UPDATE tasks SET ${sets}, updated_at=now() WHERE id=$1 AND workspace_id=$2`, [tid, req.wid, ...keys.map((k) => patch[k])]);
  const task = await taskWithAssignee(tid);
  const summary = patch.status && patch.status !== cur.status
    ? `moved "${task.title}" from ${cur.status} to ${task.status}`
    : `updated "${task.title}"`;
  await log(req, { projectId: cur.project_id, action: 'updated', entity: 'task', entityId: tid, summary });
  emitToWorkspace(req.wid, 'task:updated', task);
  res.json(task);
}));

ws.delete('/tasks/:tid', requireRole('member'), wrap(async (req, res) => {
  const tid = Number(req.params.tid);
  const { rows } = await query('DELETE FROM tasks WHERE id=$1 AND workspace_id=$2 RETURNING *', [tid, req.wid]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  await log(req, { projectId: rows[0].project_id, action: 'deleted', entity: 'task', entityId: tid, summary: `deleted task "${rows[0].title}"` });
  emitToWorkspace(req.wid, 'task:deleted', { id: tid, project_id: rows[0].project_id });
  res.json({ ok: true });
}));

// ---------- Activity ----------
ws.get('/activity', wrap(async (req, res) => {
  res.json((await query(
    `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.workspace_id=$1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`, [req.wid])).rows);
}));

export default r;
