import { io } from 'socket.io-client';

// Empty for the website (same origin / dev proxy); set VITE_API_URL to the hosted API for the desktop build.
export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const isDesktop = !!window.devboard;

let token = localStorage.getItem('token');
export const getToken = () => token;
export const setToken = (t) => {
  token = t;
  t ? localStorage.setItem('token', t) : localStorage.removeItem('token');
};

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function connectSocket() {
  return io(API_URL || undefined, { auth: { token } });
}

// GitHub OAuth start URL. In the desktop app it opens in the system browser and returns via devboard://.
export function githubUrl({ link = false } = {}) {
  const q = new URLSearchParams();
  if (link && token) q.set('token', token);
  if (isDesktop) q.set('desktop', '1');
  const s = q.toString();
  return `${API_URL}/api/auth/github${s ? `?${s}` : ''}`;
}
