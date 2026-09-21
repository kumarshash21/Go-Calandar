'use strict';
require('dotenv').config({ path: require('path').join(__dirname,'../.env') });

const express        = require('express');
const session        = require('express-session');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const NodeCache      = require('node-cache');
const path           = require('path');
const helmet         = require('helmet');
const compression    = require('compression');
const pool           = require('../db/pool');

// ── Config ────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000');
const BASE_URL   = process.env.BASE_URL   || `http://localhost:${PORT}`;
const ALLOWED    = (process.env.ALLOWED_DOMAINS||'greyorange.com').split(',').map(s=>s.trim());

const CM_TEAM = [
  'bharat.sharma@greyorange.com','charu.g@greyorange.com',
  'deepinder.k@greyorange.org','jiteshwar.m@greyorange.com',
  'kshitiz.p@greyorange.com','raghu.m@greyorange.com',
  'shania.s@greyorange.com','soumya.singh@greyorange.com'
];

// ── Cache (same role as before — just fronts Postgres now) ────
const cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// ── Helpers ───────────────────────────────────────────────────
function cacheKey(tab)  { return 'rs_'+tab; }
function invalidateCache() { cache.flushAll(); }

function normSite(s) {
  return String(s||'').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}

function nameFromEmail(email) {
  return String(email||'').split('@')[0].replace(/\./g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}

async function findSite(tab, site) {
  const { rows } = await pool.query('SELECT * FROM sites WHERE tab=$1', [tab]);
  return rows.find(r => normSite(r.site) === normSite(site));
}

// ── readSheet ─────────────────────────────────────────────────
async function readSheet(tab) {
  const ck = cacheKey(tab);
  const hit = cache.get(ck);
  if (hit) return hit;

  const { rows } = await pool.query(
    `SELECT s.id, s.site, s.pl, s.ver, s.cspoc, s.url_tower, s.url_md, s.url_butler, s.url_platform,
       COALESCE(
         jsonb_object_agg(w.week, trim(w.value)) FILTER (WHERE w.week IS NOT NULL AND trim(w.value) <> ''),
         '{}'::jsonb
       ) AS cells
     FROM sites s
     LEFT JOIN site_weeks w ON w.site_id = s.id
     WHERE s.tab = $1
     GROUP BY s.id, s.site, s.pl, s.ver, s.cspoc, s.url_tower, s.url_md, s.url_butler, s.url_platform, s.row_order
     ORDER BY s.row_order`,
    [tab]
  );

  const sites = rows.map(r => ({
    site:  r.site,
    pl:    r.pl,
    ver:   r.ver,
    cspoc: r.cspoc,
    urls: {
      tower:    r.url_tower,
      md:       r.url_md,
      butler:   r.url_butler,
      platform: r.url_platform,
    },
    cells: r.cells,
  }));

  cache.set(ck, sites);
  return sites;
}

// ── updateCell ────────────────────────────────────────────────
async function updateCell(tab, site, week, value, editorEmail) {
  const row = await findSite(tab, site);
  if (!row) throw new Error(`Site "${site}" not found`);

  const { rows: [existing] } = await pool.query(
    'SELECT value FROM site_weeks WHERE site_id=$1 AND week=$2', [row.id, week]
  );
  const oldVal = existing ? existing.value : '';

  if (String(value||'').trim() === '') {
    await pool.query('DELETE FROM site_weeks WHERE site_id=$1 AND week=$2', [row.id, week]);
  } else {
    await pool.query(
      `INSERT INTO site_weeks (site_id, week, value) VALUES ($1,$2,$3)
       ON CONFLICT (site_id, week) DO UPDATE SET value=$3`,
      [row.id, week, value]
    );
  }

  await writeAuditLog('Cell Updated', tab, site, week, oldVal, value, editorEmail);
  invalidateCache();
  return { ok: true };
}

// ── addSiteRow ────────────────────────────────────────────────
async function addSiteRow(tab, site, pl, ver, week, detail, email) {
  const existing = await findSite(tab, site);
  if (existing) return { ok:false, error:'Site already exists' };

  const { rows: [{ next }] } = await pool.query(
    'SELECT COALESCE(MAX(row_order),-1)+1 AS next FROM sites WHERE tab=$1', [tab]
  );
  const { rows: [newSite] } = await pool.query(
    `INSERT INTO sites (tab, site, pl, ver, row_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tab, site, pl||'', ver||'', next]
  );
  if (week && detail) {
    await pool.query(
      'INSERT INTO site_weeks (site_id, week, value) VALUES ($1,$2,$3)',
      [newSite.id, week, detail]
    );
  }
  await writeAuditLog('New Site Added', tab, site, week||'', '', detail||'', email);
  invalidateCache();
  return { ok: true };
}

// ── updateVersion ─────────────────────────────────────────────
async function updateVersion(tab, site, ver, email) {
  const row = await findSite(tab, site);
  if (!row) throw new Error('Site not found');
  const old = row.ver || '';
  await pool.query('UPDATE sites SET ver=$1, updated_at=now() WHERE id=$2', [ver, row.id]);
  await writeAuditLog('Version Updated', tab, site, '', old, ver, email);
  invalidateCache();
  return { ok: true };
}

// ── updateCSPOC ───────────────────────────────────────────────
async function updateCSPOC(tab, site, value, email) {
  const row = await findSite(tab, site);
  if (!row) throw new Error('Site not found');
  const old = row.cspoc || '';
  await pool.query('UPDATE sites SET cspoc=$1, updated_at=now() WHERE id=$2', [value, row.id]);
  await writeAuditLog('CS POC Updated', tab, site, 'CS POC', old, value, email);
  invalidateCache();
  return { ok: true };
}

// ── Audit ─────────────────────────────────────────────────────
async function writeAuditLog(action, tab, site, field, oldVal, newVal, email) {
  try {
    const name = nameFromEmail(email);
    await pool.query(
      `INSERT INTO meta_log (kind, tab, site, action, field, val1, val2, editor_email, editor_name)
       VALUES ('Audit',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [tab, site, action, field||'', String(oldVal||''), String(newVal||''), email||'', name]
    );
  } catch(e) { console.error('Audit error:', e.message); }
}

async function getAuditLog() {
  const { rows } = await pool.query(
    `SELECT tab, site, action, field, val1, val2, editor_email, editor_name, created_at
     FROM meta_log WHERE kind='Audit' ORDER BY id DESC`
  );
  return rows.map(r => ({
    tab: r.tab, site: r.site, action: r.action, field: r.field,
    change: `${r.val1} -> ${r.val2}`, editor: r.editor_email, name: r.editor_name,
    ts: r.created_at.toISOString(),
  }));
}

async function getAuditForDateRange(startIso, endIso) {
  const start = new Date(startIso); const end = new Date(endIso+'T23:59:59');
  const ACTIONS = new Set(['Cell Updated','Marked DONE','Marked DELAYED','Marked CANCELLED',
    'New Site Added','Version Updated','CS POC Updated','Links Updated']);

  const { rows } = await pool.query(
    `SELECT tab, site, action, field, val2, editor_email, editor_name, created_at
     FROM meta_log WHERE kind='Audit' AND created_at BETWEEN $1 AND $2`,
    [start, end]
  );
  return rows
    .filter(r => ACTIONS.has(r.action))
    .map(r => {
      const name = r.editor_name || nameFromEmail(r.editor_email);
      return {
        ts: r.created_at.toLocaleString('en-GB'), site: r.site, tab: r.tab,
        week: r.field, value: r.val2 || '', editor: name, email: r.editor_email,
        actionLabel: r.action,
      };
    })
    .sort((a,b) => b.ts.localeCompare(a.ts));
}

// ── Red Zone / War Room ────────────────────────────────────────
// NOTE: intentionally not filtered by tab and RZ never clears once set
// true — this mirrors the exact (buggy) behaviour of the original
// Sheets-backed implementation, which is preserved here on purpose.
async function getCombinedStatus(tab) {
  const ck = 'cs_'+tab; const hit = cache.get(ck); if (hit) return hit;

  const { rows } = await pool.query(
    `SELECT kind, tab, site, val1, val2 FROM meta_log WHERE kind IN ('RZ','WR') ORDER BY id ASC`
  );
  const rz = {}, wr = {};
  rows.forEach(r => {
    if (r.kind === 'RZ' && r.val1 === 'true') rz[r.site] = true;
    if (r.kind === 'WR') wr[r.site] = { site: r.site, tab: r.tab, start: r.val1, end: r.val2 };
  });
  const res = { redZones: rz, warRooms: wr };
  cache.set(ck, res, 30);
  return res;
}

async function setRedZone(tab, site, on, email) {
  await pool.query(
    `INSERT INTO meta_log (kind, tab, site, action, val1, editor_email) VALUES ('RZ',$1,$2,'RedZone',$3,$4)`,
    [tab, site, String(on), email||'']
  );
  invalidateCache();
  return { ok:true };
}

async function addWarRoom(tab, site, start, end, email) {
  await pool.query(
    `INSERT INTO meta_log (kind, tab, site, action, val1, val2, editor_email) VALUES ('WR',$1,$2,'WarRoom',$3,$4,$5)`,
    [tab, site, start, end, email||'']
  );
  invalidateCache();
  return { ok:true };
}

async function cancelWarRoom(tab, site, email) {
  await pool.query(
    `INSERT INTO meta_log (kind, tab, site, action, editor_email) VALUES ('WR_CANCEL',$1,$2,'Cancelled',$3)`,
    [tab, site, email||'']
  );
  invalidateCache();
  return { ok:true };
}

// ── Site URLs ─────────────────────────────────────────────────
async function getSiteUrlsForTab(tab) {
  const rows = await readSheet(tab); const map = {};
  rows.forEach(r => { map[r.site] = r.urls; });
  return map;
}

async function setSiteUrls(tab, site, urlsJson, email) {
  const urls = JSON.parse(urlsJson);
  const row  = await findSite(tab, site);
  if (!row) throw new Error('Site not found');

  await pool.query(
    `UPDATE sites SET url_tower=$1, url_md=$2, url_butler=$3, url_platform=$4, updated_at=now() WHERE id=$5`,
    [urls.tower||'', urls.md||'', urls.butler||'', urls.platform||'', row.id]
  );
  await writeAuditLog('Links Updated', tab, site, '', '', JSON.stringify(urls), email);
  invalidateCache();
  return { ok:true };
}

// ── Analytics ─────────────────────────────────────────────────
async function logPageView(email) {
  try {
    await pool.query(
      `INSERT INTO analytics_events (email, name, action) VALUES ($1,$2,'page_view')`,
      [email, nameFromEmail(email)]
    );
  } catch(e) {}
}

async function logAction(email, action, tab, detail) {
  try {
    await pool.query(
      `INSERT INTO analytics_events (email, name, action, tab, detail) VALUES ($1,$2,$3,$4,$5)`,
      [email, nameFromEmail(email), action, tab||'', detail||'']
    );
  } catch(e) {}
}

async function getAnalytics() {
  try {
    const { rows } = await pool.query('SELECT ts, email, name, action FROM analytics_events ORDER BY ts ASC');
    const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const week=new Date(now-7*86400000);
    const userMap={}; let totalViews=0,todayViews=0,weekViews=0; const rawPageViews=[];
    rows.forEach(r=>{
      const ts=new Date(r.ts); if(isNaN(ts))return;
      const email=r.email||''; if(!email)return;
      const name=r.name||email; const action=r.action||'';
      if(!userMap[email]) userMap[email]={email,name,views:0,actions:0,firstSeen:ts,lastSeen:ts};
      const u=userMap[email];
      if(ts>u.lastSeen)u.lastSeen=ts; if(ts<u.firstSeen)u.firstSeen=ts;
      if(action==='page_view'){
        u.views++; totalViews++;
        if(ts>=today)todayViews++;
        if(ts>=week)weekViews++;
        rawPageViews.push({ts:ts.getTime(),email,name});
      } else u.actions++;
    });
    const users=Object.values(userMap).sort((a,b)=>b.views-a.views).map(u=>({
      ...u, firstSeen:u.firstSeen.toLocaleDateString('en-GB'), lastSeen:u.lastSeen.toLocaleString('en-GB')
    }));
    return {users,totalViews,todayViews,weekViews,rawPageViews,recentActivity:[]};
  } catch(e){ return {users:[],totalViews:0,todayViews:0,weekViews:0,rawPageViews:[],recentActivity:[]}; }
}

// ── Approval workflow ─────────────────────────────────────────
async function submitForApproval(tab, site, week, newValue, oldValue, editorEmail) {
  const id = 'PND_'+Date.now();
  const name = nameFromEmail(editorEmail);
  await pool.query(
    `INSERT INTO meta_log (kind, pending_id, tab, site, field, val1, val2, editor_email, editor_name, status)
     VALUES ('PENDING',$1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [id, tab, site, week, newValue, oldValue, editorEmail, name]
  );
  return { ok:true, id };
}

async function getPendingChanges() {
  const { rows } = await pool.query(
    `SELECT pending_id, tab, site, field, val1, val2, editor_email, editor_name, created_at
     FROM meta_log WHERE kind='PENDING' AND status='pending' ORDER BY id ASC`
  );
  return rows.map(r => ({
    id: r.pending_id, tab: r.tab, site: r.site, week: r.field,
    newValue: r.val1, oldValue: r.val2, email: r.editor_email, name: r.editor_name,
    ts: r.created_at.toISOString(),
  }));
}

async function approveChange(pendingId, approverEmail) {
  const { rows: [pending] } = await pool.query(
    `SELECT * FROM meta_log WHERE kind='PENDING' AND pending_id=$1 AND status='pending'`, [pendingId]
  );
  if (!pending) return { ok:false, error:'Not found' };

  await updateCell(pending.tab, pending.site, pending.field, pending.val1, pending.editor_email);
  await pool.query(
    `UPDATE meta_log SET status='approved', approver=$1, approved_at=now() WHERE id=$2`,
    [approverEmail, pending.id]
  );
  return { ok:true };
}

async function rejectChange(pendingId, approverEmail) {
  const { rows: [pending] } = await pool.query(
    `SELECT id FROM meta_log WHERE kind='PENDING' AND pending_id=$1 AND status='pending'`, [pendingId]
  );
  if (!pending) return { ok:false, error:'Not found' };

  await pool.query(
    `UPDATE meta_log SET status='rejected', approver=$1, approved_at=now() WHERE id=$2`,
    [approverEmail, pending.id]
  );
  return { ok:true };
}

// ── Express App ───────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit:'2mb' }));
app.use(express.urlencoded({ extended:true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 24*60*60*1000, secure: process.env.NODE_ENV==='production' }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── Passport OAuth ────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  BASE_URL + '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  const email  = profile.emails?.[0]?.value || '';
  const domain = email.split('@')[1] || '';
  if (ALLOWED.length && !ALLOWED.includes(domain))
    return done(null, false, { message: 'Domain not allowed' });
  return done(null, { email, name: profile.displayName, photo: profile.photos?.[0]?.value });
}));
passport.serializeUser((u,done)=>done(null,u));
passport.deserializeUser((u,done)=>done(null,u));

// ── Auth routes ───────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google',{ scope:['profile','email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google',{ failureRedirect:'/login' }),
  (req,res) => res.redirect('/'));
app.get('/logout', (req,res) => { req.logout(()=>{}); res.redirect('/login'); });
app.get('/login', (req,res) => {
  res.send(`<!DOCTYPE html><html><head><title>GO Calendar — Sign In</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#F0F2F6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:14px;padding:44px 40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:380px;width:90%}
.logo{font-size:22px;font-weight:800;color:#1B2A4A;margin-bottom:6px}
.sub{color:#64748B;font-size:13px;margin-bottom:28px;line-height:1.5}
a.btn{display:inline-flex;align-items:center;gap:8px;background:#E86A00;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;transition:.15s}
a.btn:hover{background:#C25800}</style></head>
<body><div class="card">
  <div class="logo">GO Events Calendar</div>
  <div class="sub">GreyOrange · Release &amp; Deployment Tracker<br>Sign in with your GreyOrange account to continue.</div>
  <a class="btn" href="/auth/google">Sign in with Google</a>
</div></body></html>`);
});

// ── Auth guard ────────────────────────────────────────────────
function requireAuth(req,res,next){
  if(req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── Serve dashboard ───────────────────────────────────────────
app.get('/', requireAuth, (req,res)=>
  res.sendFile(path.join(__dirname,'../public/dashboard.html')));

// ── User info ─────────────────────────────────────────────────
app.get('/me', requireAuth, (req,res)=>
  res.json({ email: req.user.email, name: req.user.name }));

// ── API dispatcher ────────────────────────────────────────────
app.post('/api/run', requireAuth, async (req,res) => {
  const { method, args=[] } = req.body;
  const email = req.user?.email || '';
  try {
    let result;
    switch(method) {
      case 'getCurrentUserEmail':     result = email; break;
      case 'readSheet':               result = await readSheet(args[0]); break;
      case 'getCombinedStatus':       result = await getCombinedStatus(args[0]); break;
      case 'getSiteUrlsForTab':       result = await getSiteUrlsForTab(args[0]); break;
      case 'updateCell':              result = await updateCell(args[0],args[1],args[2],args[3],email); break;
      case 'addSiteRow':              result = await addSiteRow(args[0],args[1],args[2],args[3],args[4],args[5],email); break;
      case 'updateVersion':           result = await updateVersion(args[0],args[1],args[2],email); break;
      case 'updateCSPOC':             result = await updateCSPOC(args[0],args[1],args[2],email); break;
      case 'setSiteUrls':             result = await setSiteUrls(args[0],args[1],args[2],email); break;
      case 'setRedZone':              result = await setRedZone(args[0],args[1],args[2],email); break;
      case 'addWarRoom':              result = await addWarRoom(args[0],args[1],args[2],args[3],email); break;
      case 'cancelWarRoom':           result = await cancelWarRoom(args[0],args[1],email); break;
      case 'getAuditLog':             result = await getAuditLog(); break;
      case 'writeAuditLog':           await writeAuditLog(...args); result=null; break;
      case 'getAuditForDateRange':    result = await getAuditForDateRange(args[0],args[1]); break;
      case 'logPageView':             logPageView(email); result=null; break;
      case 'logAction':               logAction(email,args[1],args[2],args[3]); result=null; break;
      case 'getAnalytics':            result = await getAnalytics(); break;
      case 'submitForApproval':       result = await submitForApproval(args[0],args[1],args[2],args[3],args[4],email); break;
      case 'getPendingChanges':       result = await getPendingChanges(); break;
      case 'approveChange':           result = await approveChange(args[0],email); break;
      case 'rejectChange':            result = await rejectChange(args[0],email); break;
      default: return res.status(400).json({ error:`Unknown method: ${method}` });
    }
    res.json({ result });
  } catch(err) {
    console.error(`[${method}]`, err.message);
    res.json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  GO Events Calendar — VM Edition         ║
║  http://localhost:${PORT}                    ║
╚══════════════════════════════════════════╝
  `);
  if (!process.env.DATABASE_URL)
    console.warn('⚠  DATABASE_URL not set in .env — please configure before using');
});
