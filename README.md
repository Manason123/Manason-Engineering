# BuildTrack Pro

Multi-project construction management: baseline & BOQ, daily site reports, materials & inventory, cost control, cash flow, forecasting and an executive dashboard. Node.js + Express + SQLite backend, React (Vite) frontend. English, Kinyarwanda and French interface.

Docs: [Easiest deploy: one service on Render](docs/DEPLOY-SIMPLE.md) · [Deploy on Netlify (+API host)](docs/DEPLOY-NETLIFY.md) · [Architecture, schema & business rules](docs/ARCHITECTURE.md) · [User training guide](docs/TRAINING.md)

## Quick start (development)

Requires Node.js 20+ (tested on 22).

```bash
npm run install:all
npm test                       # 27 automated tests (calculations + full API workflow)
npm run build                  # builds the React app into client/dist
ADMIN_EMAIL=you@company.rw ADMIN_PASSWORD='Strong123' npm start
# open http://localhost:3000   (first start creates the owner account from those variables)
```

Demo data (two projects, one healthy and one delayed/over budget; all passwords `Demo12345`):

```bash
DATA_DIR=./server/data npm run seed     # only on an empty database
npm start
# owner@buildtrack.rw, pm@buildtrack.rw, engineer@buildtrack.rw, store@buildtrack.rw, accountant@buildtrack.rw
```

Frontend hot-reload: run `npm start` (API on :3000) and `npm --prefix client run dev` (UI on :5173, proxied).

## Run on a Windows laptop (no hosting needed)
Unzip the package, install Node.js LTS from https://nodejs.org, double-click **START-WINDOWS.bat**, enter the owner email and password the first time, and open http://localhost:3000. Everything (app + database) runs on that computer; other people can use it only if they can reach that computer (same Wi-Fi: `http://<laptop-ip>:3000`). Keep the window open and back up `server\data` regularly. *(Written for Windows but not tested on Windows in the authoring environment.)*

## Deployment guide

### Option A — Docker (recommended)

```bash
cp .env.example .env        # set ADMIN_EMAIL, ADMIN_PASSWORD (first start only)
docker compose up -d --build
```
Data (database, uploads, backups) lives in the `buildtrack-data` volume. *(The Dockerfile was written but could not be built in the authoring environment — run a test build before relying on it.)*

### Option B — Plain server (Ubuntu example)

```bash
sudo apt install -y nodejs npm nginx            # Node 20+ required
git clone <your repo> /opt/buildtrack && cd /opt/buildtrack
npm run install:all && npm run build
cp .env.example .env && nano .env
```
Run with systemd (`/etc/systemd/system/buildtrack.service`):
```
[Service]
WorkingDirectory=/opt/buildtrack
EnvironmentFile=/opt/buildtrack/.env
ExecStart=/usr/bin/node server/src/server.js
Restart=always
User=buildtrack
[Install]
WantedBy=multi-user.target
```
Then `systemctl enable --now buildtrack`.

### HTTPS (required in production)
Put nginx or Caddy in front and terminate TLS (e.g. Let's Encrypt). The app trusts one proxy hop (`X-Forwarded-*`). Example nginx location: `proxy_pass http://127.0.0.1:3000; client_max_body_size 20m;`.

### Configuration
| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DATA_DIR` | database, uploads, backups, token secret (default `server/data`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | create the owner account on the very first start |
| `CORS_ORIGIN` | only when the web app is on another domain (Netlify): comma-separated exact origins |
| `JWT_SECRET` | optional fixed token key; otherwise generated into `DATA_DIR/.jwt_secret` |

### Backups and restore
- The app writes a consistent SQLite backup every 24 h (and at start) to `DATA_DIR/backups`, keeping the newest 30; owners can also click **Back up now** in Settings.
- **Copy backups off the server** (another machine/cloud storage) — local backups do not protect against disk loss. Also back up `DATA_DIR/uploads` (photos/documents).
- Restore: stop the app, copy a chosen `buildtrack-….db` over `DATA_DIR/buildtrack.db`, restore `uploads/`, start the app.

### Security checklist
Change the owner password after first login · use HTTPS · restrict server SSH/firewall · keep Node and dependencies updated (`npm audit`) · keep `DATA_DIR` readable only by the service user · review the Audit log regularly. Login is rate-limited and accounts lock for 15 minutes after 5 wrong passwords. Passwords are bcrypt-hashed.

## Testing and validation

`npm test` runs 27 tests:
- **Engine tests (16)**: budget vs variations, committed ≠ actual ≠ cash, profit independent of cash, forecast cost/dates, dependencies, shortages, alert thresholds.
- **API workflow tests (11)**: logins and lockout, project-level access, BOQ import, baseline freeze, variation approval, request → PO → delivery → confirm → issue → consume chain with stock/cost assertions, report approval rules, duplicate prevention, payment approval, reversals, audit trail, role-based money hiding, exports, validation/injection input, public sign-up request → admin approval with role and projects.

The UI was also exercised in a real browser (desktop and 390 px mobile) with an end-to-end flow: engineer submits a report, project manager approves, storekeeper cannot see money.

## Project layout
```
server/src   schema.sql engine.js services.js auth.js routes_core.js routes_ops.js app.js server.js
server/test  engine.test.js api.test.js
server/scripts seed.js
client/src   App.jsx i18n.js ui.jsx styles.css pages/*
docs         ARCHITECTURE.md TRAINING.md
```
