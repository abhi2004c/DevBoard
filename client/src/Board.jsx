import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const COLUMNS = [
  ['todo', 'To Do'],
  ['in_progress', 'In Progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];

export default function Board({ wid, pid, project, can, members, socket, setErr }) {
  const [tasks, setTasks] = useState([]);
  const [sprints, setSprints] = useState([]);
  const [filter, setFilter] = useState('active'); // active | all | backlog | <id>
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(null);
  const base = `/workspaces/${wid}`;

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([api(`${base}/projects/${pid}/tasks`), api(`${base}/projects/${pid}/sprints`)]);
    setTasks(t);
    setSprints(s);
  }, [base, pid]);

  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load, setErr]);

  // Real-time sync: apply changes broadcast by other clients.
  useEffect(() => {
    const upsert = (t) => t.project_id === pid && setTasks((l) => (l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [...l, t]));
    const remove = ({ id }) => setTasks((l) => l.filter((x) => x.id !== id));
    const reload = () => load();
    socket.on('task:created', upsert);
    socket.on('task:updated', upsert);
    socket.on('task:deleted', remove);
    socket.on('tasks:changed', reload);
    socket.on('sprint:changed', reload);
    return () => {
      socket.off('task:created', upsert);
      socket.off('task:updated', upsert);
      socket.off('task:deleted', remove);
      socket.off('tasks:changed', reload);
      socket.off('sprint:changed', reload);
    };
  }, [socket, pid, load]);

  const activeSprint = sprints.find((s) => s.status === 'active');
  const visible = tasks.filter((t) =>
    filter === 'all' ? true
      : filter === 'backlog' ? !t.sprint_id
      : filter === 'active' ? (activeSprint ? t.sprint_id === activeSprint.id : true)
      : t.sprint_id === Number(filter));

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api(`${base}/projects/${pid}/tasks`, {
        method: 'POST',
        body: { title, sprint_id: filter !== 'all' && filter !== 'backlog' ? (filter === 'active' ? activeSprint?.id : Number(filter)) || null : null },
      });
      setTitle('');
    } catch (ex) { setErr(ex.message); }
  }

  async function patch(id, body) {
    setTasks((l) => l.map((t) => (t.id === id ? { ...t, ...body } : t))); // optimistic
    try { await api(`${base}/tasks/${id}`, { method: 'PATCH', body }); } catch (ex) { setErr(ex.message); load(); }
  }

  async function drop(e, status) {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('id'));
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    const last = Math.max(0, ...tasks.filter((x) => x.status === status).map((x) => x.position));
    patch(id, { status, position: last + 1 });
  }

  async function remove(id) {
    try { await api(`${base}/tasks/${id}`, { method: 'DELETE' }); setEditing(null); } catch (ex) { setErr(ex.message); }
  }

  return (
    <>
      <div className="toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="active">{activeSprint ? `Active: ${activeSprint.name}` : 'All tasks (no active sprint)'}</option>
          <option value="all">All tasks</option>
          <option value="backlog">Backlog</option>
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
        </select>
        {can('member') && (
          <form onSubmit={add} className="inline">
            <input placeholder="New task title…" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="primary">Add</button>
          </form>
        )}
      </div>

      <div className="columns">
        {COLUMNS.map(([status, label]) => {
          const col = visible.filter((t) => t.status === status);
          return (
            <section key={status} className="column" onDragOver={(e) => can('member') && e.preventDefault()} onDrop={(e) => can('member') && drop(e, status)}>
              <h3>{label} <span className="count">{col.length}</span></h3>
              {col.map((t) => (
                <div key={t.id} className={`task p-${t.priority}`} draggable={can('member')}
                  onDragStart={(e) => e.dataTransfer.setData('id', String(t.id))}
                  onClick={() => setEditing(t)}>
                  <div><span className="muted">{project?.key}-{t.id}</span> {t.title}</div>
                  {t.links?.length > 0 && (
                    <div className="meta">
                      {t.links.map((l, i) => (
                        <a key={i} className={`badge gl-${l.state}`} href={l.url} target="_blank" rel="noreferrer"
                          title={l.title} onClick={(e) => e.stopPropagation()}>
                          {l.kind === 'pr' ? `PR ${l.state}` : l.kind}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="meta">
                    <span className="badge">{t.priority}</span>
                    {t.points != null && <span className="badge">{t.points} pts</span>}
                    {t.assignee_name && <span className="muted">@{t.assignee_name}</span>}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>

      {editing && (
        <TaskModal task={tasks.find((t) => t.id === editing.id) || editing} members={members} sprints={sprints}
          readOnly={!can('member')} onClose={() => setEditing(null)}
          onSave={(b) => { patch(editing.id, b); setEditing(null); }} onDelete={() => remove(editing.id)} />
      )}
    </>
  );
}

function TaskModal({ task, members, sprints, readOnly, onClose, onSave, onDelete }) {
  const [f, setF] = useState({
    title: task.title, description: task.description, priority: task.priority,
    points: task.points ?? '', assignee_id: task.assignee_id ?? '', sprint_id: task.sprint_id ?? '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    onSave({
      ...f,
      points: f.points === '' ? null : Number(f.points),
      assignee_id: f.assignee_id === '' ? null : Number(f.assignee_id),
      sprint_id: f.sprint_id === '' ? null : Number(f.sprint_id),
    });
  };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Task #{task.id}</h2>
        <fieldset disabled={readOnly}>
          <input value={f.title} onChange={set('title')} required />
          <textarea rows={4} placeholder="Description" value={f.description} onChange={set('description')} />
          <label>Priority
            <select value={f.priority} onChange={set('priority')}>
              {['low', 'medium', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>Story points <input type="number" min="0" value={f.points} onChange={set('points')} /></label>
          <label>Assignee
            <select value={f.assignee_id} onChange={set('assignee_id')}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Sprint
            <select value={f.sprint_id} onChange={set('sprint_id')}>
              <option value="">Backlog</option>
              {sprints.filter((s) => s.status !== 'completed').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </fieldset>
        <div className="row">
          {!readOnly && <button className="primary">Save</button>}
          {!readOnly && <button type="button" className="danger" onClick={onDelete}>Delete</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </div>
  );
}
