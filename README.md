# DevBoard

Multi-tenant project & sprint management with real-time updates.
React (Vite) · Node/Express · PostgreSQL · Socket.io

## Run with Docker
    docker compose up --build      # app at http://localhost:8080

## Run locally
1. Start PostgreSQL and create a database: `createdb devboard`
2. `cd server && cp .env.example .env` (edit DATABASE_URL), `npm install`, `npm run dev` (schema auto-migrates)
3. `cd client && npm install && npm run dev` → http://localhost:5173

## Design
- **Tenancy:** every row carries `workspace_id`; all routes live under `/api/workspaces/:wid/...` and pass a membership guard. Socket rooms (`ws:<id>`) are joined only after a membership check.
- **RBAC:** owner > admin > member > viewer. Admins manage projects/sprints/members; members edit tasks; viewers read only.
- **Real-time:** task, sprint, member and activity events broadcast to the workspace room.
- **Activity log:** every mutation is recorded and streamed live.

## Desktop app (Windows)
Electron wrapper in `desktop/` around the same React client; it talks to the hosted API.
1. Set the API address in `client/.env.desktop` (`VITE_API_URL=https://your-api.example.com`).
2. `cd desktop && npm install`
3. Try it: `npm run build:web && npm start` (dev against the Vite server: `npm run dev`).
4. Installer: `npm run dist:win` → `desktop/dist/DevBoard Setup 1.0.0.exe`.
5. On the server add `app://devboard` to `CLIENT_ORIGIN` (comma-separated list).

GitHub sign-in in the desktop app opens the system browser and returns through the `devboard://auth` link.
Mac: `npm run dist:win` becomes `electron-builder --mac`, but must be run on a Mac (or a GitHub Actions macOS runner).

## Going online
Set on the server host: `DATABASE_URL`, `DB_SSL=true` (hosted Postgres), `JWT_SECRET`, `CLIENT_ORIGIN`
(website URL + `app://devboard`), `APP_URL` (public URL of the API), GitHub OAuth vars.
