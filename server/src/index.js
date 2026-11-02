import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app.js';
import { initRealtime } from './realtime.js';
import { migrate } from './migrate.js';

// Comma-separated allowed origins: website(s) plus the desktop app (app://devboard).
const origin = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,app://devboard').split(',').map((s) => s.trim());
const server = http.createServer(createApp(origin));
initRealtime(server, origin);

await migrate();
const port = process.env.PORT || 4000;
server.listen(port, () => console.log(`DevBoard API on :${port}`));
