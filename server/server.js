'use strict';
// Load project-root .env (VM) first, then server/.env (local); dotenv never overrides already-set vars
require('dotenv').config({ path: require('path').join(__dirname,'../.env') });
require('dotenv').config({ path: require('path').join(__dirname,'.env') });

const express        = require('express');
const NodeCache      = require('node-cache');
const path           = require('path');
const helmet         = require('helmet');
const compression    = require('compression');
const pool           = require('../db/pool');
const { matchCRs, aliasHint, activityOf, tabHint, productTab, norm } = require('./crMatch');

// ── Config ────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000');

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

// ── Salesforce (CR Deployment Calendar) ───────────────────────
const https = require('https');

let sfToken = null; // { accessToken, instanceUrl, fetchedAt }

function sfPost(hostname, reqPath, form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const req = https.request({
      hostname, path: reqPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sfGet(hostname, reqPath, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: reqPath, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchSfToken() {
  const form = {
    grant_type: 'client_credentials',
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  };
  let host = new URL(process.env.SF_INSTANCE_URL).hostname;
  let res = await sfPost(host, '/services/oauth2/token', form);
  if (res.status === 302 && res.headers.location) {
    host = new URL(res.headers.location).hostname;
    res = await sfPost(host, '/services/oauth2/token', form);
  }
  if (res.status !== 200) throw new Error(`Salesforce auth failed (${res.status}): ${res.body.slice(0,200)}`);
  const json = JSON.parse(res.body);
  return { accessToken: json.access_token, instanceUrl: json.instance_url, fetchedAt: Date.now() };
}

async function getSfToken(forceRefresh) {
  if (!forceRefresh && sfToken && (Date.now() - sfToken.fetchedAt) < 50*60*1000) return sfToken;
  sfToken = await fetchSfToken();
  return sfToken;
}

async function sfQuery(soql) {
  const apiVer = process.env.SF_API_VERSION || 'v60.0';
  let path = `/services/data/${apiVer}/query/?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (path) {
    let token = await getSfToken(false);
    let res = await sfGet(new URL(token.instanceUrl).hostname, path, token.accessToken);
    if (res.status === 401) {
      token = await getSfToken(true);
      res = await sfGet(new URL(token.instanceUrl).hostname, path, token.accessToken);
    }
    if (res.status !== 200) throw new Error(`Salesforce query failed (${res.status}): ${res.body.slice(0,200)}`);
    const json = JSON.parse(res.body);
    records.push(...json.records);
    path = json.done ? null : json.nextRecordsUrl;
  }
  return records;
}

function sfCaseUrl(caseId) {
  if (!caseId || !process.env.SF_INSTANCE_URL) return '';
  const host = new URL(process.env.SF_INSTANCE_URL).hostname.replace('.my.salesforce.com', '.lightning.force.com');
  return `https://${host}/lightning/r/Case/${encodeURIComponent(caseId)}/view`;
}

// CR number typed into a calendar note ("CRN#236028") -> Salesforce case link.
const crLinkCache = {};
async function getCRLink(crn) {
  const num = String(crn || '').replace(/\D/g, '');
  if (!num || num.length > 8) return '';
  const padded = num.padStart(8, '0');
  if (crLinkCache[padded] === undefined) {
    const recs = await sfQuery(`SELECT Id FROM Case WHERE CaseNumber = '${padded}' LIMIT 1`);
    crLinkCache[padded] = recs.length ? sfCaseUrl(recs[0].Id) : '';
  }
  return crLinkCache[padded];
}

// Calendar starts at Week 13 (23 Mar 2026); older CRs can never land on a cell.
const CR_FROM = '2026-03-23T00:00:00Z';
let crRaw = null; // { at, rows } — Salesforce events, refreshed every 1 min

async function loadCRRaw(force) {
  if (!force && crRaw && Date.now() - crRaw.at < 60*1000) return crRaw.rows;
  const soql = `SELECT Id, Subject, What.Name, StartDateTime, EndDateTime, Case_Number__c, Case_Id__c, Closer_code_status__c
                FROM Event WHERE Case_Number__c != null AND StartDateTime >= ${CR_FROM}
                ORDER BY StartDateTime DESC`;
  const records = await sfQuery(soql);
  // Change Type (GreyMatter Upgrade, Firmware Update, ...) lives on the Case, not the Event.
  const changeType = {}, product = {};
  const nums = [...new Set(records.map(r => r.Case_Number__c).filter(Boolean))];
  for (let i = 0; i < nums.length; i += 150) {
    const list = nums.slice(i, i + 150).map(n => `'${String(n).replace(/[^0-9A-Za-z]/g, '')}'`).join(',');
    try {
      const cases = await sfQuery(`SELECT CaseNumber, Change_Type__c, Product_Type__c FROM Case WHERE CaseNumber IN (${list})`);
      cases.forEach(c => { changeType[c.CaseNumber] = c.Change_Type__c || ''; product[c.CaseNumber] = c.Product_Type__c || ''; });
    } catch (e) { console.warn('[CR] change type lookup failed:', e.message); break; }
  }
  const rows = records.map(r => ({
    id: r.Id,
    crNumber: r.Case_Number__c || '',
    subject: r.Subject || '',
    account: (r.What && r.What.Name) || '',
    url: sfCaseUrl(r.Case_Id__c),
    changeType: changeType[r.Case_Number__c] || '',
    product: product[r.Case_Number__c] || '',
    start: r.StartDateTime ? new Date(r.StartDateTime).toISOString() : null,
    end:   r.EndDateTime   ? new Date(r.EndDateTime).toISOString()   : null,
    status: r.Closer_code_status__c || 'Scheduled',
  }));
  crRaw = { at: Date.now(), rows };
  return rows;
}

let aliasTableReady = false;
async function ensureAliasTable() {
  if (aliasTableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cr_site_alias (
    alias TEXT NOT NULL, tab TEXT NOT NULL, site TEXT NOT NULL,
    editor_email TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (alias, tab, site))`);
  aliasTableReady = true;
}

async function getCRDeployments(force) {
  const [raw, rtp, rms] = await Promise.all([loadCRRaw(!!force), readSheet('rtp'), readSheet('rms')]);
  await ensureAliasTable();
  const { rows: aliases } = await pool.query('SELECT alias, tab, site FROM cr_site_alias');
  const matched = matchCRs(raw, { rtp, rms }, aliases);
  // A Salesforce account with no calendar row still gets one (shown live, never saved): the CR's account is the site.
  // Tab = the CR's product (RTP/TTP/Relay -> Advance Automations; RIL/RMS/RA/Casepick -> Automation Essentials).
  return matched.map(cr => {
    if (!cr.matches.length && !cr.candidates.length && cr.account) {
      cr.matches = [{ tab: cr.tab || 'rtp', site: cr.account, fromSalesforce: true }];
      cr.matchedBy = 'salesforce';
    }
    if (!cr.matches.length) cr.aliasHint = cr.account || aliasHint(cr.subject);
    cr.activity = activityOf(cr.subject, cr.matches.map(m => m.site));
    return cr;
  });
}

// Teach the matcher that a phrase in a CR subject (e.g. "Kenco Fairlife") means a calendar row.
async function setCRAlias(alias, tab, site, email) {
  alias = String(alias||'').trim();
  if (!alias || !['rtp','rms'].includes(tab)) throw new Error('alias and tab (rtp|rms) are required');
  const row = await findSite(tab, site);
  if (!row) throw new Error(`Unknown site "${site}" on ${tab}`);
  await ensureAliasTable();
  await pool.query(
    `INSERT INTO cr_site_alias (alias, tab, site, editor_email) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [alias.toLowerCase(), tab, row.site, email||'']
  );
  return { ok:true };
}

async function getCRSites() {
  const [rtp, rms] = await Promise.all([readSheet('rtp'), readSheet('rms')]);
  return [].concat(rtp.map(r => ({ tab:'rtp', site:r.site })), rms.map(r => ({ tab:'rms', site:r.site })));
}

// ── Express App ───────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit:'2mb' }));
app.use(express.urlencoded({ extended:true }));

// ── Serve dashboard ───────────────────────────────────────────
app.get('/', (req,res)=>
  res.sendFile(path.join(__dirname,'../public/dashboard.html')));

// Frontend calls /me on load; no auth in VM mode, so return an empty identity
app.get('/me', (req,res)=> res.json({ email:'' }));
app.get('/favicon.ico', (req,res)=> res.status(204).end());

// ── API dispatcher ────────────────────────────────────────────
app.post('/api/run', async (req,res) => {
  const { method, args=[] } = req.body;
  const email = '';
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
      case 'getCRDeployments':        result = await getCRDeployments(args[0]); break;
      case 'setCRAlias':              result = await setCRAlias(args[0],args[1],args[2],email); break;
      case 'getCRLink':               result = await getCRLink(args[0]); break;
      case 'getCRSites':              result = await getCRSites(); break;
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
