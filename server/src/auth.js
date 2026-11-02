import jwt from 'jsonwebtoken';
import { query } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret';

export const signToken = (user) => jwt.sign({ uid: user.id }, SECRET, { expiresIn: '7d' });
export const verifyToken = (token) => jwt.verify(token, SECRET);

// Role hierarchy used for RBAC checks.
const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

export async function getMembership(workspaceId, userId) {
  const { rows } = await query(
    'SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, userId]
  );
  return rows[0]?.role || null;
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.userId = verifyToken(token).uid;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Tenant guard: resolves :wid, verifies membership, and exposes req.role.
export async function requireWorkspace(req, res, next) {
  const wid = Number(req.params.wid);
  if (!Number.isInteger(wid)) return res.status(400).json({ error: 'Bad workspace id' });
  const role = await getMembership(wid, req.userId);
  if (!role) return res.status(404).json({ error: 'Workspace not found' });
  req.wid = wid;
  req.role = role;
  next();
}

export const requireRole = (min) => (req, res, next) =>
  RANK[req.role] >= RANK[min] ? next() : res.status(403).json({ error: `Requires ${min} role` });
