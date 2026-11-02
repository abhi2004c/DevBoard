import React, { useEffect, useState } from 'react';
import { api, getToken, setToken, githubUrl, isDesktop } from './api.js';
import Workspace from './Workspace.jsx';

function Auth({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const d = await api(`/auth/${mode}`, { method: 'POST', body: f });
      setToken(d.token);
      onAuth(d.user);
    } catch (ex) {
      setErr(ex.message);
    }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h1>DevBoard</h1>
      <p className="muted">Real-time collaborative workspace for dev teams</p>
      {mode === 'register' && <input placeholder="Name" value={f.name} onChange={set('name')} required />}
      <input type="email" placeholder="Email" value={f.email} onChange={set('email')} required />
      <input type="password" placeholder="Password (6+ chars)" value={f.password} onChange={set('password')} required />
      {err && <div className="error">{err}</div>}
      <button className="primary">{mode === 'login' ? 'Log in' : 'Create account'}</button>
      <a className="btn gh" href={githubUrl()} target={isDesktop ? '_blank' : undefined} rel="noreferrer">Continue with GitHub</a>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

// Pick up the token / error that the GitHub OAuth callback puts in the URL.
const params = new URLSearchParams(location.search);
const oauthError = params.get('error');
if (params.get('token')) setToken(params.get('token'));
if (params.has('token') || params.has('error')) history.replaceState(null, '', location.pathname);

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());
  const [deskErr, setDeskErr] = useState('');

  // Desktop app: the devboard:// deep link delivers the token after GitHub login in the browser.
  useEffect(() => {
    if (!isDesktop) return;
    return window.devboard.onAuth(({ token, error }) => {
      if (error) return setDeskErr(error);
      setToken(token);
      api('/me').then((u) => { setUser(u); setReady(true); }).catch((e) => setDeskErr(e.message));
    });
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    api('/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  if (!user) return (
    <>
      {(oauthError || deskErr) && <div className="error banner">{oauthError || deskErr}</div>}
      <Auth onAuth={setUser} />
    </>
  );
  return <Workspace user={user} onLogout={() => { setToken(null); setUser(null); }} />;
}
