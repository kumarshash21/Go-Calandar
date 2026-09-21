# GO Events Calendar — VM Deployment Guide

> Calendar data, audit log, red-zone/war-room state and analytics all live in
> **Postgres** now — the Google Sheet is no longer read or written by the
> running app. It is only used once, as the source for the migration script
> that seeds Postgres. Sign-in is still Google OAuth, unchanged.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | https://nodejs.org |
| Git | any | https://git-scm.com |
| Docker | ≥ 20 | https://docker.com *(optional, for GCP; also runs Postgres)* |
| PostgreSQL | ≥ 13 | bundled via `docker-compose`, or your own instance |

---

## PART 1 — Google Cloud Setup (One-time — sign-in + migration)

### A. Create a GCP Project
1. Go to https://console.cloud.google.com
2. Create a new project: `go-calendar-vm`

### B. Enable APIs
- **Google Sheets API** *(only needed to run the one-time migration script)*
- **Google OAuth2 API** (under "Google+ API" or search "Google Identity")

### C. Service Account (read-only, migration only)
1. **IAM & Admin → Service Accounts → Create Service Account**
2. Name: `go-calendar-server`, click **Create and Continue → Done**
3. Click the service account → **Keys → Add Key → JSON**
4. Download the JSON file → save as **`credentials/service-account.json`** in this folder
5. **Share the sheet you're migrating from** with the service account email (Viewer is enough):
   - Open the sheet → Share → add `go-calendar-server@YOUR_PROJECT.iam.gserviceaccount.com`

### D. OAuth Credentials (user login — still required)
1. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Name: `GO Calendar`
4. Authorised redirect URIs — add both:
   - `http://localhost:3000/auth/google/callback` (local dev)
   - `https://YOUR_GCP_VM_IP/auth/google/callback` (GCP — fill in later)
5. Click **Create** — copy **Client ID** and **Client Secret**

---

## PART 2 — Deploy Locally (Testing)

### Step 1 — Run setup
```bash
node scripts/setup.js
```
This creates `.env`, a `credentials/` folder, and installs npm packages.

### Step 2 — Configure `.env`
```bash
nano .env   # or open in your editor
```
Fill in:
```env
DATABASE_URL=postgres://go_calendar:password@localhost:5432/go_calendar
GOOGLE_CLIENT_ID=your-oauth-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-oauth-client-secret
SESSION_SECRET=run-this-to-generate:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
BASE_URL=http://localhost:3000
ALLOWED_DOMAINS=greyorange.com

# Only needed for the one-time migration below
SHEET_ID=your_sheet_id_here
```

### Step 3 — Start Postgres
Easiest with Docker (also used in production — see Part 3):
```bash
docker compose up -d postgres
```
Or point `DATABASE_URL` at any Postgres instance you already have.

### Step 4 — Create the schema
```bash
npm run db:init
```

### Step 5 — Migrate the Google Sheet in (one-time)
Requires `SHEET_ID` and `credentials/service-account.json` from Part 1:
```bash
npm run db:migrate
```
This copies the RTP/TTP tab, RMS/RIL tab, `GO_Meta` audit/red-zone/war-room
log, and `GO_Analytics` into Postgres. Safe to re-run — site rows and week
cells are upserted (log/analytics rows will duplicate on a second run, so
only run it once against a given sheet).

### Step 6 — Start
```bash
npm start
```

### Step 7 — Test
Open **http://localhost:3000** → sign in with your GreyOrange Google account.

✅ **Verify these work:**
- [ ] Login redirects to Google and back
- [ ] Calendar loads with the migrated data
- [ ] Click a cell → can save changes
- [ ] Summary panel opens
- [ ] This Week panel opens

---

## PART 3 — Deploy on GCP VM

### Step 1 — Create a GCP VM
```
Compute Engine → VM Instances → Create Instance
- Machine type: e2-small (2 vCPU, 2GB) — sufficient for 100 users
- Boot disk: Ubuntu 22.04 LTS, 20GB
- Firewall: Allow HTTP and HTTPS traffic
```

### Step 2 — SSH into the VM
```bash
gcloud compute ssh go-calendar-vm --zone=YOUR_ZONE
```

### Step 3 — Install Docker
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

### Step 4 — Upload the package
From your MacBook:
```bash
gcloud compute scp go-events-calendar-vm.zip go-calendar-vm:~/ --zone=YOUR_ZONE
```
On the VM:
```bash
unzip go-events-calendar-vm.zip
cd go-events-calendar
```

### Step 5 — Configure on VM
```bash
cp .env.example .env
nano .env
```
Update:
```env
BASE_URL=http://YOUR_VM_EXTERNAL_IP
PORT=80
POSTGRES_PASSWORD=set-a-real-password
```
`docker-compose.yml` runs Postgres for you and wires `DATABASE_URL`
automatically from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`.

If you still need to migrate from the Google Sheet, also add the service
account key:
```bash
mkdir -p credentials
nano credentials/service-account.json  # paste the JSON key content
```

### Step 6 — Add VM IP to OAuth redirect URIs
Back in GCP Console → OAuth Credentials → edit your client:
- Add: `http://YOUR_VM_EXTERNAL_IP/auth/google/callback`

### Step 7 — Start with Docker
```bash
docker-compose up -d
docker-compose logs -f   # watch logs
```

### Step 8 — Run the schema + migration (first deploy only)
```bash
docker-compose exec go-calendar npm run db:init
docker-compose exec go-calendar npm run db:migrate   # only if migrating from Sheets
```

### Step 9 — Verify
Open `http://YOUR_VM_EXTERNAL_IP` in your browser.

---

## PART 4 — HTTPS (Production-grade, optional but recommended)

### Using nginx + Let's Encrypt (if you have a domain)
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/go-calendar
```
Paste:
```nginx
server {
    server_name your-domain.greyorange.com;
    location / {
        proxy_pass         http://localhost:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/go-calendar /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.greyorange.com
sudo nginx -s reload
```
Update `.env`: `BASE_URL=https://your-domain.greyorange.com`
Update OAuth redirect URI to use `https://`.

---

## Backups

Postgres now holds the data the Google Sheet used to hold. Back it up like
any other production database, e.g.:
```bash
docker compose exec postgres pg_dump -U go_calendar go_calendar > backup.sql
```

---

## File Structure

```
go-events-calendar/
├── server/
│   └── server.js          ← Express server (all API logic, reads/writes Postgres)
├── db/
│   ├── schema.sql         ← Postgres schema
│   ├── pool.js            ← pg connection pool
│   └── init.js            ← applies schema.sql (npm run db:init)
├── public/
│   └── dashboard.html     ← Full dashboard UI (unchanged)
├── scripts/
│   ├── setup.js               ← Setup wizard
│   └── migrate-from-sheets.js ← One-time Google Sheet → Postgres migration
├── credentials/
│   └── service-account.json  ← only needed for the migration script
├── package.json
├── .env                   ← YOU CREATE THIS (from .env.example)
├── .env.example
├── Dockerfile
├── docker-compose.yml     ← app + Postgres
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module` | Run `npm install` |
| `DATABASE_URL not set` | Edit `.env` — add your Postgres connection string |
| `relation "sites" does not exist` | Run `npm run db:init` |
| `ECONNREFUSED` connecting to Postgres | Check Postgres is running and `DATABASE_URL` host/port are correct |
| `Domain not allowed` | Add your domain to `ALLOWED_DOMAINS` in `.env` |
| `redirect_uri_mismatch` | Add exact callback URL in GCP OAuth settings |
| Migration fails to read the sheet | Share it with the service account email; check `SHEET_ID` and `GOOGLE_KEY_FILE` |
| Port 3000 in use | Change `PORT=3001` in `.env` |
# Go-Calandar
