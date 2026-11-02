import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export function Sprints({ wid, pid, can, socket, setErr }) {
  const [sprints, setSprints] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [f, setF] = useState({ name: '', goal: '', start_date: '', end_date: '' });
  const base = `/workspaces/${wid}`;

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([api(`${base}/projects/${pid}/sprints`), api(`${base}/projects/${pid}/tasks`)]);
    setSprints(s);
    setTasks(t);
  }, [base, pid]);

  useEffect(() => {
    load().catch((e) => setErr(e.message));
    const evts = ['sprint:changed', 'task:created', 'task:updated', 'task:deleted', 'tasks:changed'];
    evts.forEach((e) => socket.on(e, load));
    return () => evts.forEach((e) => socket.off(e, load));
  }, [load, socket, setErr]);

  async function create(e) {
    e.preventDefault();
    try {
      await api(`${base}/projects/${pid}/sprints`, { method: 'POST', body: f });
      setF({ name: '', goal: '', start_date: '', end_date: '' });
    } catch (ex) { setErr(ex.message); }
  }
  const setStatus = (id, status) =>
    api(`${base}/sprints/${id}`, { method: 'PATCH', body: { status } }).catch((ex) => setErr(ex.message));

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div>
      {can('admin') && (
        <form className="card row wrap" onSubmit={create}>
          <input placeholder="Sprint name" value={f.name} onChange={set('name')} required />
          <input placeholder="Goal" value={f.goal} onChange={set('goal')} />
          <input type="date" value={f.start_date} onChange={set('start_date')} />
          <input type="date" value={f.end_date} onChange={set('end_date')} />
          <button className="primary">Create sprint</button>
        </form>
      )}
      {sprints.map((s) => {
        const st = tasks.filter((t) => t.sprint_id === s.id);
        const done = st.filter((t) => t.status === 'done');
        const pts = (l) => l.reduce((a, t) => a + (t.points || 0), 0);
        const pct = st.length ? Math.round((done.length / st.length) * 100) : 0;
        return (
          <div key={s.id} className="card">
            <div className="row">
              <strong>{s.name}</strong> <span className={`badge s-${s.status}`}>{s.status}</span>
              <span className="spacer" />
              {can('admin') && s.status === 'planned' && <button onClick={() => setStatus(s.id, 'active')}>Start</button>}
              {can('admin') && s.status === 'active' && <button onClick={() => setStatus(s.id, 'completed')}>Complete</button>}
            </div>
            {s.goal && <p className="muted">{s.goal}</p>}
            <p className="muted">
              {s.start_date?.slice(0, 10) || '—'} → {s.end_date?.slice(0, 10) || '—'} · {done.length}/{st.length} tasks · {pts(done)}/{pts(st)} pts
            </p>
            <div className="bar"><div style={{ width: `${pct}%` }} /></div>
          </div>
        );
      })}
      {sprints.length === 0 && <div className="empty">No sprints yet.</div>}
    </div>
  );
}

export function Activity({ wid, socket, setErr }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    api(`/workspaces/${wid}/activity`).then(setItems).catch((e) => setErr(e.message));
    const add = (a) => setItems((l) => [a, ...l].slice(0, 100));
    socket.on('activity:new', add);
    return () => socket.off('activity:new', add);
  }, [wid, socket, setErr]);
  return (
    <div className="card">
      <h3>Activity</h3>
      {items.map((a) => (
        <div key={a.id} className="activity">
          <strong>{a.user_name || 'Someone'}</strong> {a.summary}
          <span className="muted"> · {new Date(a.created_at).toLocaleString()}</span>
        </div>
      ))}
      {items.length === 0 && <div className="muted">Nothing yet.</div>}
    </div>
  );
}

export function Members({ wid, role, can, members, user, setErr }) {
  const [email, setEmail] = useState('');
  const [r, setR] = useState('member');
  const base = `/workspaces/${wid}/members`;

  async function invite(e) {
    e.preventDefault();
    try { await api(base, { method: 'POST', body: { email, role: r } }); setEmail(''); } catch (ex) { setErr(ex.message); }
  }
  const change = (id, nr) => api(`${base}/${id}`, { method: 'PATCH', body: { role: nr } }).catch((ex) => setErr(ex.message));
  const remove = (id) => api(`${base}/${id}`, { method: 'DELETE' }).catch((ex) => setErr(ex.message));

  return (
    <div className="card">
      <h3>Members</h3>
      {can('admin') && (
        <form className="row wrap" onSubmit={invite}>
          <input type="email" placeholder="Registered user's email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={r} onChange={(e) => setR(e.target.value)}>
            {['admin', 'member', 'viewer'].map((x) => <option key={x}>{x}</option>)}
          </select>
          <button className="primary">Add</button>
        </form>
      )}
      {members.map((m) => (
        <div key={m.id} className="row member">
          <span>{m.name} <span className="muted">{m.email}</span></span>
          <span className="spacer" />
          {can('admin') && m.role !== 'owner' && m.id !== user.id ? (
            <>
              <select value={m.role} onChange={(e) => change(m.id, e.target.value)}>
                {['admin', 'member', 'viewer'].map((x) => <option key={x}>{x}</option>)}
              </select>
              <button className="danger" onClick={() => remove(m.id)}>Remove</button>
            </>
          ) : <span className="badge">{m.role}</span>}
        </div>
      ))}
    </div>
  );
}
