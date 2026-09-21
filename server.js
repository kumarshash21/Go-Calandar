'use strict';
require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google }     = require('googleapis');
const NodeCache      = require('node-cache');
const path           = require('path');
const fs             = require('fs');

// ── Config ────────────────────────────────────────────────────
const SHEET_ID       = process.env.SHEET_ID;
const RTP_SHEET      = process.env.RTP_SHEET      || 'RTP/TTP Release Calender';
const RMS_SHEET      = process.env.RMS_SHEET      || 'RMS/RIL/CasePick Release Calender';
const META_SHEET     = 'GO_Meta';
const ANALYTICS_SHEET= 'GO_Analytics';
const ALLOWED_DOMAINS= (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);
const PORT           = process.env.PORT || 3000;

// ── Cache (replaces GAS CacheService) ────────────────────────
const cache = new NodeCache({ stdTTL: 180 }); // 3 min default

// ── Google Sheets auth (service account) ─────────────────────
function getSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './credentials.json';
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Helpers ───────────────────────────────────────────────────
function sheetName(tab) { return tab === 'rms' ? RMS_SHEET : RTP_SHEET; }
function cacheKey(tab)  { return 'rs_v2_' + tab; }
function csKey(tab)     { return 'cs_v1_' + tab; }

function invalidateCache(tab) {
  cache.del(cacheKey('rtp')); cache.del(cacheKey('rms'));
  cache.del(csKey('rtp'));    cache.del(csKey('rms'));
}

// ── readSheet ─────────────────────────────────────────────────
async function readSheet(tab) {
  const ck = cacheKey(tab);
  const hit = cache.get(ck);
  if (hit) return hit;

  const sheets = getSheetsClient();
  const name   = sheetName(tab);
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${name}'` });
  const rows   = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  // Find column indices
  const SITE_COL = 0, PL_COL = 1, VER_COL = 2;
  const weekCols = {}, urlCols = { tower: -1, md: -1, butler: -1, platform: -1 };

  headers.forEach((h, i) => {
    if (typeof h === 'string') {
      const hu = h.trim().toUpperCase();
      if (h.trim().startsWith('Week ') || h.trim().startsWith('Wk ')) weekCols[h.trim()] = i;
      if (hu === 'TOWER URL')        urlCols.tower    = i;
      if (hu === 'MD URL')           urlCols.md       = i;
      if (hu === 'BUTLER SERVER URL')urlCols.butler   = i;
      if (hu === 'PLATFORM URL')     urlCols.platform = i;
    }
  });

  const sites = [];
  for (let r = 1; r < rows.length; r++) {
    const row  = rows[r] || [];
    const site = (row[SITE_COL] || '').trim();
    if (!site) continue;

    const cells = {};
    Object.entries(weekCols).forEach(([wk, ci]) => {
      const v = (row[ci] || '').trim();
      if (v) cells[wk] = v;
    });

    const urls = {
      tower:    (urlCols.tower    >= 0 ? row[urlCols.tower]    : '') || '',
      md:       (urlCols.md       >= 0 ? row[urlCols.md]       : '') || '',
      butler:   (urlCols.butler   >= 0 ? row[urlCols.butler]   : '') || '',
      platform: (urlCols.platform >= 0 ? row[urlCols.platform] : '') || '',
    };

    sites.push({
      site, pl: (row[PL_COL] || '').trim(),
      ver: (row[VER_COL] || '').trim(),
      cells, urls, _rowIndex: r + 1
    });
  }

  if (JSON.stringify(sites).length < 90000) cache.set(ck, sites);
  return sites;
}

// ── updateCell ────────────────────────────────────────────────
async function updateCell(tab, site, week, value, editorEmail) {
  const sheets = getSheetsClient();
  const name   = sheetName(tab);
  const rows_  = await readSheet(tab);
  const row    = rows_.find(r => r.site.trim().toLowerCase() === site.trim().toLowerCase());
  if (!row) return { ok: false, error: 'Site not found' };

  // Find week column index
  const metaRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${name}'!1:1` });
  const headers = (metaRes.data.values || [[]])[0] || [];
  const colIdx  = headers.findIndex(h => (h || '').trim() === week);
  if (colIdx < 0) return { ok: false, error: 'Week column not found' };

  const colLetter = colIndexToLetter(colIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${name}'!${colLetter}${row._rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  });

  await writeAuditLog('Cell Updated', tab, site, week, row.cells[week] || '', value, editorEmail);
  invalidateCache(tab);
  return { ok: true };
}

// ── addSiteRow ────────────────────────────────────────────────
async function addSiteRow(tab, site, pl, ver, week, detail, editorEmail) {
  const sheets = getSheetsClient();
  const name   = sheetName(tab);
  // Check not duplicate
  const existing = await readSheet(tab);
  if (existing.find(r => r.site.toLowerCase() === site.toLowerCase()))
    return { ok: false, error: 'Site already exists' };

  const headers = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${name}'!1:1` })).data.values[0] || [];
  const weekIdx = week ? headers.findIndex(h => h.trim() === week) : -1;
  const newRow  = new Array(headers.length).fill('');
  newRow[0] = site; newRow[1] = pl || ''; newRow[2] = ver || '';
  if (weekIdx >= 0 && detail) newRow[weekIdx] = detail;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${name}'`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] }
  });

  await writeAuditLog('New Site Added', tab, site, week || '', '', detail || '', editorEmail);
  invalidateCache(tab);
  return { ok: true };
}

// ── updateVersion ─────────────────────────────────────────────
async function updateVersion(tab, site, ver, editorEmail) {
  const sheets = getSheetsClient();
  const name   = sheetName(tab);
  const rows_  = await readSheet(tab);
  const row    = rows_.find(r => r.site.toLowerCase() === site.toLowerCase());
  if (!row) return { ok: false };

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${name}'!C${row._rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ver]] }
  });
  await writeAuditLog('Version Updated', tab, site, '', row.ver || '', ver, editorEmail);
  invalidateCache(tab);
  return { ok: true };
}

// ── Meta sheet helpers ────────────────────────────────────────
async function getMetaRows() {
  const sheets = getSheetsClient();
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: META_SHEET });
  return res.data.values || [];
}

async function appendMeta(row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: META_SHEET,
    valueInputOption: 'RAW', requestBody: { values: [row] }
  });
}

// ── Audit ─────────────────────────────────────────────────────
async function writeAuditLog(action, tab, site, field, oldVal, newVal, email) {
  try {
    await appendMeta(['Audit', tab, site, action, field, `${oldVal} -> ${newVal}`, email || 'unknown', new Date().toISOString()]);
  } catch(e) { console.error('Audit error:', e.message); }
}

async function getAuditLog() {
  const rows = await getMetaRows();
  return rows.filter(r => r[0] === 'Audit').map(r => ({
    tab: r[1], site: r[2], action: r[3], field: r[4], change: r[5], editor: r[6], ts: r[7]
  })).reverse();
}

async function getAuditForDateRange(startIso, endIso) {
  const rows  = await getMetaRows();
  const start = new Date(startIso); const end = new Date(endIso + 'T23:59:59');
  const ACTIONS = { 'Cell Updated':true, 'Marked DONE':true, 'Marked DELAYED':true,
    'Marked CANCELLED':true, 'New Site Added':true, 'Version Updated':true, 'Links Updated':true };
  return rows.filter(r => {
    if (r[0] !== 'Audit') return false;
    if (!ACTIONS[r[3]]) return false;
    const ts = new Date(r[7]);
    return !isNaN(ts) && ts >= start && ts <= end;
  }).map(r => {
    const val    = (r[5] || '');
    const newVal = val.includes(' -> ') ? val.split(' -> ').slice(1).join(' -> ').trim() : val;
    const email  = r[6] || '';
    const name   = email.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { ts: new Date(r[7]).toLocaleString('en-GB'), site: r[2], tab: r[1],
             week: r[4], value: newVal, editor: name, email, actionLabel: r[3] };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
}

// ── Red Zone / War Room ───────────────────────────────────────
async function readAllMeta() {
  const rows = await getMetaRows();
  const rz = {}, wr = { active: {} }, audit = [];
  rows.forEach(r => {
    if (r[0] === 'RZ')    { if (r[4] === 'true') rz[r[1]+':'+r[2]] = true; }
    if (r[0] === 'WR')    { wr.active[r[1]+':'+r[2]] = { site:r[2], tab:r[1], start:r[4], end:r[5] }; }
    if (r[0] === 'Audit') { audit.push(r); }
  });
  return { rz, wr, audit };
}

async function getCombinedStatus(tab) {
  const ck = csKey(tab); const hit = cache.get(ck); if (hit) return hit;
  const meta = await readAllMeta();
  const redZones = {}, warRooms = {}, allWarRoomPeriods = {};
  Object.keys(meta.rz).forEach(k => { if (k.startsWith(tab+':')) redZones[k.split(':')[1]] = true; });
  Object.keys(meta.wr.active).forEach(k => {
    if (k.startsWith(tab+':')) {
      const w = meta.wr.active[k];
      warRooms[w.site] = { start: w.start, end: w.end };
    }
  });
  const result = { redZones, warRooms, allWarRoomPeriods };
  cache.set(ck, result, 30);
  return result;
}

async function setRedZone(tab, site, on, email) {
  await appendMeta(['RZ', tab, site, 'RedZone', String(on), '', email, new Date().toISOString()]);
  cache.del(csKey(tab)); cache.del(csKey('rtp')); cache.del(csKey('rms'));
  return { ok: true };
}

async function addWarRoom(tab, site, start, end, email) {
  await appendMeta(['WR', tab, site, 'WarRoom', start, end, email, new Date().toISOString()]);
  cache.del(csKey(tab)); cache.del(csKey('rtp')); cache.del(csKey('rms'));
  return { ok: true };
}

async function cancelWarRoom(tab, site, email) {
  // Mark WR as cancelled in meta (simple approach)
  await appendMeta(['WR_CANCEL', tab, site, 'Cancelled', '', '', email, new Date().toISOString()]);
  cache.del(csKey(tab));
  return { ok: true };
}

// ── Site URLs ─────────────────────────────────────────────────
async function getSiteUrlsForTab(tab) {
  const rows = await readSheet(tab);
  const map  = {};
  rows.forEach(r => { map[r.site] = r.urls; });
  return map;
}

async function setSiteUrls(tab, site, urlsJson, email) {
  const sheets  = getSheetsClient();
  const name    = sheetName(tab);
  const rows_   = await readSheet(tab);
  const row     = rows_.find(r => r.site.toLowerCase() === site.toLowerCase());
  if (!row) return { ok: false };

  const headers = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${name}'!1:1` })).data.values[0] || [];
  const urls    = JSON.parse(urlsJson);
  const fields  = { 'Tower URL':'tower', 'MD URL':'md', 'Butler Server URL':'butler', 'Platform URL':'platform' };
  
  const updates = [];
  Object.entries(fields).forEach(([hdr, key]) => {
    const ci = headers.findIndex(h => h.trim() === hdr);
    if (ci >= 0) updates.push({ range: `'${name}'!${colIndexToLetter(ci)}${row._rowIndex}`, value: urls[key] || '' });
  });

  for (const u of updates) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: u.range,
      valueInputOption: 'RAW', requestBody: { values: [[u.value]] }
    });
  }
  await writeAuditLog('Links Updated', tab, site, '', '', JSON.stringify(urls), email);
  invalidateCache(tab);
  return { ok: true };
}

// ── Analytics ─────────────────────────────────────────────────
async function ensureAnalyticsSheet() {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ANALYTICS_SHEET}!A1` });
  } catch(e) {
    // Sheet doesn't exist - create it via batchUpdate would require Sheets API v4 addSheet
    // For simplicity, just append - if sheet missing it'll throw
    console.log('Analytics sheet may not exist yet, will be created on first write');
  }
}

async function logPageView(email) {
  try {
    const name = email.split('@')[0].replace(/\./g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: ANALYTICS_SHEET,
      valueInputOption: 'RAW',
      requestBody: { values: [[new Date().toISOString(), email, name, 'page_view', '', '']] }
    });
  } catch(e) { /* silent */ }
}

async function logAction(email, action, tab, detail) {
  try {
    const name = email.split('@')[0].replace(/\./g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: ANALYTICS_SHEET,
      valueInputOption: 'RAW',
      requestBody: { values: [[new Date().toISOString(), email, name, action, tab||'', detail||'']] }
    });
  } catch(e) { /* silent */ }
}

async function getAnalytics() {
  try {
    const sheets = getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: ANALYTICS_SHEET });
    const rows_  = (res.data.values || []).slice(1);
    const now    = new Date();
    const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week   = new Date(now - 7*86400000);
    const userMap = {};
    let totalViews=0, todayViews=0, weekViews=0;
    const recent = [];

    rows_.forEach(r => {
      const ts    = new Date(r[0]||''); if (isNaN(ts)) return;
      const email = r[1]||''; if (!email) return;
      const name  = r[2]||email; const action = r[3]||'';
      if (!userMap[email]) userMap[email] = { email, name, views:0, actions:0, firstSeen:ts, lastSeen:ts };
      const u = userMap[email];
      if (ts > u.lastSeen) u.lastSeen = ts;
      if (ts < u.firstSeen) u.firstSeen = ts;
      if (action === 'page_view') {
        u.views++; totalViews++;
        if (ts >= today) todayViews++;
        if (ts >= week)  weekViews++;
      } else { u.actions++; }
      if (recent.length < 20) recent.push({ ts:ts.toLocaleString('en-GB'), email, name, action, tab:r[4]||'', detail:(r[5]||'').substring(0,50) });
    });

    const users = Object.values(userMap).sort((a,b)=>b.views-a.views).map(u => ({
      ...u,
      firstSeen: u.firstSeen.toLocaleDateString('en-GB'),
      lastSeen:  u.lastSeen.toLocaleString('en-GB')
    }));
    return { users, totalViews, todayViews, weekViews, recentActivity: recent.reverse() };
  } catch(e) { return { users:[], totalViews:0, todayViews:0, weekViews:0, recentActivity:[] }; }
}

// ── Utility ───────────────────────────────────────────────────
function colIndexToLetter(idx) {
  let s = '';
  idx++;
  while (idx > 0) { const rem = (idx-1) % 26; s = String.fromCharCode(65+rem) + s; idx = Math.floor((idx-1)/26); }
  return s;
}

// ── Express App ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 24*60*60*1000 } }));
app.use(passport.initialize());
app.use(passport.session());

// ── Passport Google OAuth ─────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  (process.env.BASE_URL || 'http://localhost:3000') + '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  const email  = profile.emails?.[0]?.value || '';
  const domain = email.split('@')[1] || '';
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain))
    return done(null, false, { message: 'Domain not allowed' });
  return done(null, { email, name: profile.displayName, photo: profile.photos?.[0]?.value });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Auth routes ───────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/')
);
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>GO Calendar – Sign In</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F0F2F6}
.card{background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.1);max-width:360px}
h1{color:#1B2A4A;font-size:22px;margin-bottom:8px}p{color:#64748B;font-size:14px;margin-bottom:24px}
a{background:#E86A00;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block}
a:hover{background:#C25800}</style></head>
<body><div class="card"><h1>GO Events Calendar</h1><p>Sign in with your GreyOrange Google account to continue.</p>
<a href="/auth/google">Sign in with Google</a></div></body></html>`);
});
app.get('/logout', (req, res) => { req.logout(()=>{}); res.redirect('/login'); });

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── Static files (dashboard) ──────────────────────────────────
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ── API router — all GAS functions as POST /api/run ───────────
// The frontend uses a shim that POSTs { method, args } here
app.post('/api/run', requireAuth, async (req, res) => {
  const { method, args = [] } = req.body;
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
      case 'setSiteUrls':             result = await setSiteUrls(args[0],args[1],args[2],email); break;
      case 'setRedZone':              result = await setRedZone(args[0],args[1],args[2],email); break;
      case 'addWarRoom':              result = await addWarRoom(args[0],args[1],args[2],args[3],email); break;
      case 'cancelWarRoom':           result = await cancelWarRoom(args[0],args[1],email); break;
      case 'getAuditLog':             result = await getAuditLog(); break;
      case 'writeAuditLog':           result = await writeAuditLog(...args); break;
      case 'getAuditForDateRange':    result = await getAuditForDateRange(args[0],args[1]); break;
      case 'logPageView':             logPageView(email); result = null; break;  // fire & forget
      case 'logAction':               logAction(email,args[1],args[2],args[3]); result = null; break;
      case 'getAnalytics':            result = await getAnalytics(); break;
      case 'readAllMeta':             result = await readAllMeta(); break;
      default: return res.status(400).json({ error: `Unknown method: ${method}` });
    }
    res.json({ result });
  } catch(err) {
    console.error(`API error [${method}]:`, err.message);
    res.json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✓ GO Events Calendar running at http://localhost:${PORT}`);
  console.log(`  Sign in at: http://localhost:${PORT}/login\n`);
});
