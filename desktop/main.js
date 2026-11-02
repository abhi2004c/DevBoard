const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEV = process.env.ELECTRON_DEV === '1';
const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'client', 'dist');

// Serve the built React app from app://devboard so it has a real, CORS-friendly origin (not file://).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win;

function send(payload) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('auth', payload);
}

// devboard://auth?token=... (or ?error=...) -> hand to the renderer.
function handleDeepLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'devboard:' || u.hostname !== 'auth') return;
    const token = u.searchParams.get('token');
    const error = u.searchParams.get('error');
    send(token ? { token } : { error: error || 'Login failed' });
  } catch { /* ignore malformed links */ }
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('devboard', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('devboard');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows/Linux: the deep link arrives as an argument of a second launch.
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('devboard://'));
    if (link) handleDeepLink(link);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); }); // macOS

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([\/])+/, '') || 'index.html';
      const file = path.join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    win = new BrowserWindow({
      width: 1280, height: 800, minWidth: 900, minHeight: 600, title: 'DevBoard',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);

    // Anything that is not the app itself opens in the user's browser (e.g. GitHub login, PR links).
    const isInternal = (u) => u.startsWith('app://devboard') || (DEV && u.startsWith('http://localhost:5173'));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!isInternal(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
    });

    win.loadURL(DEV ? 'http://localhost:5173' : 'app://devboard/index.html');

    const initial = process.argv.find((a) => a.startsWith('devboard://'));
    if (initial) win.webContents.once('did-finish-load', () => handleDeepLink(initial));
  });

  app.on('window-all-closed', () => app.quit());
}
