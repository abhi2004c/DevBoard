import React, { useCallback, useEffect, useState } from 'react';
import { api, githubUrl, isDesktop } from './api.js';

const LABEL = {
  member: 'In workspace',
  invited: 'Invited',
  on_devboard: 'On DevBoard',
  not_on_devboard: 'Not on DevBoard yet',
};

export default function GitHub({ wid, pid, project, projects, can, socket, setErr }) {
  const base = `/workspaces/${wid}/github`;
  const [status, setStatus] = useState(null);
  const [repos, setRepos] = useState([]);
  const [pick, setPick] = useState('');
  const [collabs, setCollabs] = useState([]);
  const [roles, setRoles] = useState({});
  const [msg, setMsg] = useState('');

  const linked = status?.repos.find((r) => r.project_id === pid);

  const loadStatus = useCallback(() => api(`${base}/status`).then(setStatus).catch((e) => setErr(e.message)), [base, setErr]);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadCollabs = useCallback(async () => {
    if (!linked) return setCollabs([]);
    try { setCollabs(await api(`${base}/projects/${pid}/collaborators`)); } catch (e) { setErr(e.message); }
  }, [base, pid, linked, setErr]);
  useEffect(() => {
    loadCollabs();
    socket.on('members:changed', loadCollabs);
    return () => socket.off('members:changed', loadCollabs);
  }, [loadCollabs, socket]);

  useEffect(() => {
    if (status?.connected && can('admin') && !linked) {
      api(`${base}/repos`).then(setRepos).catch((e) => setErr(e.message));
    }
  }, [status?.connected, linked, base, can, setErr]);

  async function link() {
    try {
      const r = await api(`${base}/link`, { method: 'POST', body: { project_id: pid, full_name: pick } });
      setMsg(`Linked ${r.full_name}. Webhook: ${r.webhook}`);
      loadStatus();
    } catch (e) { setErr(e.message); }
  }
  async function unlink() {
    try { await api(`${base}/link/${pid}`, { method: 'DELETE' }); setMsg(''); loadStatus(); } catch (e) { setErr(e.message); }
  }
  async function invite(login) {
    try {
      await api(`${base}/invite`, { method: 'POST', body: { login, role: roles[login] || 'member' } });
      loadCollabs();
    } catch (e) { setErr(e.message); }
  }
  async function importIssues() {
    try {
      const r = await api(`${base}/projects/${pid}/import-issues`, { method: 'POST' });
      setMsg(`Imported ${r.imported} issue(s), skipped ${r.skipped} already imported.`);
    } catch (e) { setErr(e.message); }
  }

  if (!status) return null;
  if (!status.oauth) {
    return <div className="card">GitHub is not configured on the server. Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in <code>server/.env</code> and restart.</div>;
  }

  return (
    <div>
      <div className="card row">
        {status.connected ? (
          <>
            {status.avatar && <img className="avatar" src={status.avatar} alt="" />}
            <span>Connected as <strong>@{status.login}</strong></span>
          </>
        ) : (
          <>
            <span>Your GitHub account is not connected.</span>
            <span className="spacer" />
            <a className="btn gh" href={githubUrl({ link: true })} target={isDesktop ? '_blank' : undefined} rel="noreferrer">Connect GitHub</a>
          </>
        )}
      </div>

      {msg && <div className="card">{msg}</div>}

      {status.connected && project && (
        <div className="card">
          <h3>Repository for {project.key} · {project.name}</h3>
          {linked ? (
            <>
              <div className="row">
                <a href={`https://github.com/${linked.full_name}`} target="_blank" rel="noreferrer">{linked.full_name}</a>
                <span className="spacer" />
                {can('member') && <button onClick={importIssues}>Import open issues</button>}
                {can('admin') && <button className="danger" onClick={unlink}>Unlink</button>}
              </div>
              <p className="muted">
                Mention a task key like <code>{project.key}-{'<id>'}</code> in a PR title, branch name or commit message to attach it
                to the task. Opening a PR moves it to Review; merging moves it to Done.
                {!status.webhooks && ' (Webhooks are off: set WEBHOOK_URL on the server to a public URL.)'}
              </p>
            </>
          ) : can('admin') ? (
            <div className="row wrap">
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a repository…</option>
                {repos.map((r) => <option key={r.full_name} value={r.full_name}>{r.full_name}{r.private ? ' 🔒' : ''}</option>)}
              </select>
              <button className="primary" disabled={!pick} onClick={link}>Link to project</button>
            </div>
          ) : <div className="muted">No repository linked. Ask an admin.</div>}
        </div>
      )}

      {linked && (
        <div className="card">
          <h3>Repository collaborators</h3>
          {collabs.map((c) => (
            <div key={c.login} className="row member">
              <img className="avatar" src={c.avatar} alt="" />
              <a href={c.url} target="_blank" rel="noreferrer">@{c.login}</a>
              <span className={`badge ${c.state === 'member' ? 's-active' : ''}`}>{LABEL[c.state]}{c.role ? ` · ${c.role}` : ''}</span>
              <span className="spacer" />
              {can('admin') && c.state !== 'member' && (
                <>
                  <select value={roles[c.login] || 'member'} onChange={(e) => setRoles({ ...roles, [c.login]: e.target.value })}>
                    {['admin', 'member', 'viewer'].map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <button onClick={() => invite(c.login)}>
                    {c.state === 'on_devboard' ? 'Add to workspace' : c.state === 'invited' ? 'Update invite' : 'Invite'}
                  </button>
                </>
              )}
            </div>
          ))}
          <p className="muted">People not on DevBoard yet get a pending invite and join this workspace automatically when they sign in with GitHub.</p>
        </div>
      )}
    </div>
  );
}
