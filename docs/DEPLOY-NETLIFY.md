# Deploying BuildTrack Pro: Netlify (web app) + a server for the API

**Important:** Netlify hosts static websites and short serverless functions. BuildTrack Pro also has an API and a database with uploaded photos, which need a server with a **persistent disk**. So it is deployed in two parts:

| Part | Where | Why |
|---|---|---|
| Web app (`client/`) | **Netlify** | Fast, free HTTPS, global CDN |
| API + database + photos (`server/`) | **Render** (blueprint included), or Railway / Fly.io / any VPS | SQLite file and uploads must survive restarts |

Order matters: deploy the API first (you need its URL), then Netlify.

## Part 1: the API (Render example)

1. Put the project in a GitHub repository (the whole `buildtrack` folder).
2. On render.com: **New → Blueprint** → choose the repository. It reads `render.yaml`.
3. When asked, enter `ADMIN_EMAIL` and `ADMIN_PASSWORD` (this creates the owner account on first start; pick a strong password) and leave `CORS_ORIGIN` empty for now.
4. After it is live you get a URL such as `https://buildtrack-api.onrender.com`. Open `https://…/api/health`: it must show `{"ok":true}`.

Notes: Render needs a **paid instance for the persistent disk** (the free plan loses your data on restart, so do not use it for real work); check Render's current prices. The app makes a daily backup into the disk; copy backups elsewhere regularly. Any server with Node 20+ and a disk works the same way (see README, "Deployment guide").

## Part 2: the web app on Netlify

**Option A: from GitHub (recommended, automatic updates)**
1. netlify.com → **Add new site → Import an existing project** → pick the same repository. Netlify reads `netlify.toml` (base `client`, build `npm ci && npm run build`, publish `dist`).
2. **Before the first build**: Site configuration → Environment variables → add
   `VITE_API_URL` = `https://buildtrack-api.onrender.com` (your API URL, **no trailing slash, no /api**).
3. Deploy. You get `https://something.netlify.app`.

**Option B: manual upload (no GitHub)**
```bash
cd client
VITE_API_URL=https://buildtrack-api.onrender.com npm run build
```
Then drag the `client/dist` folder onto https://app.netlify.com/drop.

**Option C: ready-made site folder (no Node, no GitHub, works from a computer)**
Use `buildtrack-netlify-site.zip`: unzip it, open `config.js` in Notepad and put your API address between the quotes (`window.BUILDTRACK_API_URL = "https://buildtrack-api.onrender.com";`), save, then drag the **folder** onto https://app.netlify.com/drop. To change the address later, edit `config.js` and drop the folder again. (`config.js` overrides `VITE_API_URL`.)

## Part 3: connect them (do not skip)

On the API host set `CORS_ORIGIN` to your Netlify address, exactly, e.g. `https://something.netlify.app` (several allowed, comma-separated; a custom domain must be added too). Redeploy/restart the API. Without this the browser blocks all calls and the login shows "Network error".

Then open the Netlify URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

If you change `VITE_API_URL` later you must **re-deploy** the Netlify site (the value is baked in at build time).

## Adding users

- **Admin adds directly:** top menu **Users → Add user** (name, email, role, temporary password).
- **People ask to join:** on the sign-in page they choose **Request access** and fill in their name, email, phone, password and a note. Nothing works until an owner/admin approves: **Users** shows a gold number badge; open it, choose the **role** and tick the **projects** the person may see, then **Approve** (or **Reject** with a reason). Approved people can sign in immediately.
- Roles: owner, admin, project_manager, engineer, storekeeper, accountant, viewer. Engineers/storekeepers/viewers never see money figures.
- Forgot password: an admin sets a new one in Users (there is no automatic email yet).

## Install on a phone

Open the Netlify address in Chrome/Safari → menu → **Add to Home Screen**. It opens like an app with the BuildTrack icon.

## Custom domain and checklist

- Netlify: Domain management → add your domain (e.g. `app.yourcompany.rw`); add the same address to `CORS_ORIGIN`.
- Change the owner password in **My profile** after the first sign-in.
- Check `/api/health` after every API deploy; keep backups off the server.

## Troubleshooting: "the page opens but nothing works"

The sign-in page now shows a red box **"The server is not connected"** with the API address it is trying to use.

| What you see | Cause | Fix |
|---|---|---|
| Box says "No API was found at this address" and `API: (not set)` | `VITE_API_URL` was not set when Netlify built the site | Set it in Netlify → Environment variables, then **Deploys → Trigger deploy → Clear cache and deploy** |
| Box says "cannot reach the API… CORS" | API is down, wrong URL, or `CORS_ORIGIN` does not match your Netlify address exactly | Open `<API URL>/api/health` in a browser (must show `{"ok":true}`); set `CORS_ORIGIN=https://your-site.netlify.app` and restart the API |
| No red box, but login says "Invalid email or password" | The owner account does not exist yet | It is created only on the API's first start from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Sign in with those. |

**The first owner is never created through "Request access".** Request access makes a pending request that an existing owner/admin must approve. The owner comes from `ADMIN_EMAIL` on the server.
