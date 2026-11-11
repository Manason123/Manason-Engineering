# Easiest way: ONE service on Render (no Netlify needed)

The BuildTrack server can show the web app **and** run the API/database from the same address. You deploy once, open one link, sign in. No `VITE_API_URL`, no CORS, no red "server not connected" box.

## What you need
- A GitHub account (free) and a Render account (render.com, sign in with GitHub).
- The file `buildtrack.zip` unzipped on your computer.

## 1. Put the code on GitHub (browser only, about 5 minutes)
1. github.com → **New repository** → name `buildtrack` → **Private** → Create.
2. Click **uploading an existing file**.
3. Open the unzipped `buildtrack` folder, select **everything inside it** (folders `client`, `server`, `docs` and the files `package.json`, `render.yaml`, `Dockerfile` …) and drag it into the page. (The project has 65 files; the web uploader accepts up to 100.)
4. Important: `package.json` and the folders `client` and `server` must appear at the **top level** of the repository, not inside another `buildtrack` folder.
5. **Commit changes**.

## 2. Create the service on Render
1. render.com → **New → Web Service** → pick your `buildtrack` repository.
2. Fill in:
   - **Runtime / Language:** Node
   - **Build Command:** `npm --prefix client ci && npm --prefix client run build && npm --prefix server ci --omit=dev`
   - **Start Command:** `node server/src/server.js`
   - **Instance type:** *Free* to try it out (data is erased whenever it restarts or redeploys). For real work use a paid type **with a Disk** mounted at `/var/data` and set `DATA_DIR=/var/data`.
3. **Environment variables** (Add):
   - `NODE_VERSION` = `22`
   - `ADMIN_EMAIL` = your email (this becomes the owner login)
   - `ADMIN_PASSWORD` = a strong password (8+ characters, letters and digits)
   - `ADMIN_NAME` = your name
   - (paid with disk only) `DATA_DIR` = `/var/data`
4. **Create Web Service**. Wait until the log says "BuildTrack Pro listening". The first build takes a few minutes.

## 3. Use it
Open the address Render shows (e.g. `https://buildtrack-xxxx.onrender.com`). Check `…/api/health` shows `{"ok":true}`. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then add projects and users (Users → Add user, or approve **Request access**).

The free plan goes to sleep when idle (first open after a pause takes ~1 minute) and **loses data on restart**: use it only to try the app.

## If something fails
- Build error mentioning `better-sqlite3`: make sure `NODE_VERSION` is `22`, then **Manual Deploy → Clear build cache & deploy**.
- Login says invalid password: the owner is created only the first time the server starts with an empty database. If you started it without `ADMIN_EMAIL`/`ADMIN_PASSWORD`, set them and redeploy (on the free plan the database is empty after every restart, so it is recreated automatically).
- The Netlify route (`DEPLOY-NETLIFY.md`) is only needed if you want the web app on Netlify and the API elsewhere.
