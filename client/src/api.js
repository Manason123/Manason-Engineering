const KEY = 'bt_token';
// Empty = same origin (served by the backend). On Netlify set VITE_API_URL=https://your-backend.example.com
// Runtime setting (public/config.js, editable after build) wins over the build-time VITE_API_URL.
const RAW = (typeof window !== 'undefined' && window.BUILDTRACK_API_URL) || import.meta.env.VITE_API_URL || '';
const API = String(RAW).trim().replace(/\/+$/, '').replace(/\/api$/, '') + '/api';
export const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, url, body, isForm) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + url, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  } catch {
    const e = new Error('Network error. Check your connection and try again.');
    e.offline = true;
    throw e;
  }
  // A static host (Netlify) answers unknown paths with index.html and status 200: that is NOT an API answer.
  if (!(res.headers.get('content-type') || '').includes('json')) {
    const e = new Error('The server is not connected. The web app cannot reach the API (check VITE_API_URL and redeploy).');
    e.offline = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !url.startsWith('/auth/')) onUnauthorized();
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.details = data.details;
    throw e;
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b || {}),
  put: (u, b) => request('PUT', u, b || {}),
  patch: (u, b) => request('PATCH', u, b || {}),
  del: (u) => request('DELETE', u),
  upload: (u, form) => request('POST', u, form, true),
};

export async function download(url, fallbackName) {
  const res = await fetch(API + url, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? decodeURIComponent(m[1]) : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function openFile(url) {
  const res = await fetch(API + url, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('Could not open file');
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
}

/** Returns { ok, base, reason } so the sign-in page can explain why nothing works. */
export async function checkApi() {
  const base = API.replace(/\/api$/, '');
  try {
    const res = await fetch(API + '/health');
    const isJson = (res.headers.get('content-type') || '').includes('json');
    if (res.ok && isJson && (await res.json()).ok) return { ok: true, base };
    return { ok: false, base, reason: 'notfound' };
  } catch {
    return { ok: false, base, reason: 'network' };
  }
}
