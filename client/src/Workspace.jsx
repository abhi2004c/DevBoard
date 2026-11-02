import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectSocket } from './api.js';
import Board from './Board.jsx';
import { Sprints, Activity, Members } from './Panels.jsx';
import GitHub from './GitHub.jsx';

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

export default function Workspace({ user, onLogout }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [wid, setWid] = useState(null);
  const [role, setRole] = useState('viewer');
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState(null);
  const [members, setMembers] = useState([]);
  const [tab, setTab] = useState('board');
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const socketRef = useRef(null);
  const [socket, setSocket] = useState(null);

  const can = (min) => RANK[role] >= RANK[min];

  useEffect(() => {
    api('/workspaces').then((w) => { setWorkspaces(w); if (w[0]) setWid(w[0].id); });
    const s = connectSocket();
    socketRef.current = s;
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);
    return () => s.close();
  }, []);

  const loadProjects = useCallback(async (keep) => {
    if (!wid) return;
    const p = await api(`/workspaces/${wid}/projects`);
    setProjects(p);
    setPid((cur) => (keep && p.some((x) => x.id === cur) ? cur : p[0]?.id ?? null));
  }, [wid]);

  const loadMembers = useCallback(() => wid && api(`/workspaces/${wid}/members`).then(setMembers), [wid]);

  useEffect(() => {
    if (!wid || !socket) return;
    setRole(workspaces.find((w) => w.id === wid)?.role || 'viewer');
    const join = () => socket.emit('workspace:join', wid);
    join();
    socket.on('connect', join);
    loadProjects(false);
    loadMembers();
    const onProject = () => loadProjects(true);
    socket.on('project:created', onProject);
    socket.on('members:changed', loadMembers);
    return () => {
      socket.off('connect', join);
      socket.off('project:created', onProject);
      socket.off('members:changed', loadMembers);
    };
  }, [wid, socket, workspaces, loadProjects, loadMembers]);

  async function newWorkspace() {
    const name = prompt('Workspace name');
    if (!name) return;
    try {
      const w = await api('/workspaces', { method: 'POST', body: { name } });
      setWorkspaces((l) => [...l, w]);
      setWid(w.id);
    } catch (e) { setErr(e.message); }
  }

  async function newProject() {
    const name = prompt('Project name');
    const key = name && prompt('Project key (2-6 letters, e.g. WEB)');
    if (!name || !key) return;
    try {
      const p = await api(`/workspaces/${wid}/projects`, { method: 'POST', body: { name, key } });
      await loadProjects(false);
      setPid(p.id);
    } catch (e) { setErr(e.message); }
  }

  const project = projects.find((p) => p.id === pid);
  const ctx = { wid, pid, project, role, can, members, socket, user, setErr };

  return (
    <div className="app">
      <header>
        <strong className="logo">DevBoard</strong>
        <select value={wid || ''} onChange={(e) => setWid(Number(e.target.value))}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button onClick={newWorkspace}>+ Workspace</button>
        {wid && (
          <>
            <select value={pid || ''} onChange={(e) => setPid(Number(e.target.value))}>
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </select>
            {can('admin') && <button onClick={newProject}>+ Project</button>}
          </>
        )}
        <span className="spacer" />
        <span className={`dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Offline'} />
        <span className="muted">{user.name} ({role})</span>
        <button onClick={onLogout}>Log out</button>
      </header>

      {err && <div className="error banner" onClick={() => setErr('')}>{err} ✕</div>}

      {!wid ? (
        <div className="empty">Create a workspace to get started.</div>
      ) : (
        <>
          <nav>
            {['board', 'sprints', 'activity', 'members', 'github'].map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
            ))}
          </nav>
          <main>
            {tab === 'members' && <Members {...ctx} />}
            {tab === 'activity' && <Activity {...ctx} />}
            {tab === 'github' && <GitHub {...ctx} projects={projects} />}
            {tab === 'github' ? null : !pid ? <div className="empty">{can('admin') ? 'Create a project to begin.' : 'No projects yet.'}</div>
              : tab === 'board' ? <Board {...ctx} />
              : tab === 'sprints' ? <Sprints {...ctx} /> : null}
          </main>
        </>
      )}
    </div>
  );
}
