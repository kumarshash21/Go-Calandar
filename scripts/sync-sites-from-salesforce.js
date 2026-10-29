// Pulls every distinct Salesforce account that has a CR event and adds it to
// `sites` (skipping ones already there), then gives each new site a blank
// site_links row. Safe to re-run; never changes existing sites or links.
// Usage: node scripts/sync-sites-from-salesforce.js [--dry-run]
require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });
const { Pool } = require('pg');
const { productTab, tabHint, norm, fixMojibake } = require('../server/crMatch');

const DRY = process.argv.includes('--dry-run');
const CR_FROM = '2026-03-23T00:00:00Z';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function sfToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });
  let url = new URL('/services/oauth2/token', process.env.SF_INSTANCE_URL);
  let res;
  for (let i = 0; i < 2; i++) { // same host-redirect handling as server.js
    res = await fetch(url, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (res.status !== 302 || !res.headers.get('location')) break;
    url = new URL('/services/oauth2/token', res.headers.get('location'));
  }
  if (!res.ok) throw new Error(`Salesforce auth failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { token: j.access_token, base: j.instance_url };
}

async function query(t, soql) {
  const ver = process.env.SF_API_VERSION || 'v60.0';
  let url = `${t.base}/services/data/${ver}/query/?q=${encodeURIComponent(soql)}`;
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.token } });
    if (!res.ok) throw new Error(`Salesforce query failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    out.push(...j.records);
    url = j.done ? null : t.base + j.nextRecordsUrl;
  }
  return out;
}

(async () => {
  const t = await sfToken();
  const events = await query(t,
    `SELECT Subject, What.Name, Case_Number__c FROM Event WHERE Case_Number__c != null AND StartDateTime >= ${CR_FROM}`);
  const nums = [...new Set(events.map(e => e.Case_Number__c))];
  const product = {};
  for (let i = 0; i < nums.length; i += 150) {
    const list = nums.slice(i, i + 150).map(n => `'${String(n).replace(/[^0-9A-Za-z]/g, '')}'`).join(',');
    (await query(t, `SELECT CaseNumber, Product_Type__c FROM Case WHERE CaseNumber IN (${list})`))
      .forEach(c => { product[c.CaseNumber] = c.Product_Type__c || ''; });
  }

  // account -> tab (first CR that identifies a product wins; default 'rtp')
  const found = new Map();
  for (const e of events) {
    const name = fixMojibake((e.What && e.What.Name || '').trim());
    if (!name) continue;
    const tab = productTab(product[e.Case_Number__c]) || tabHint(e.Subject || '');
    if (!found.has(name) || (tab && !found.get(name))) found.set(name, tab || null);
  }

  const { rows: existing } = await pool.query('SELECT tab, site FROM sites');
  const have = new Set(existing.map(r => norm(r.site)));
  const fresh = [...found].filter(([n]) => !have.has(norm(n))).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`${found.size} Salesforce accounts, ${fresh.length} not yet in sites.`);
  if (DRY) { fresh.forEach(([n, tab]) => console.log(`  ${tab || 'rtp'}\t${n}`)); return; }

  for (const [name, tab0] of fresh) {
    const tab = tab0 || 'rtp';
    await pool.query(
      `INSERT INTO sites (tab, site, row_order)
       VALUES ($1, $2, COALESCE((SELECT max(row_order) + 1 FROM sites WHERE tab = $1), 0))
       ON CONFLICT (tab, site) DO NOTHING`, [tab, name]);
  }
  await pool.query(
    `INSERT INTO site_links (site_id, tab, site, pl)
     SELECT id, tab, site, pl FROM sites ON CONFLICT (site_id) DO NOTHING`);
  const { rows: [c] } = await pool.query('SELECT (SELECT count(*) FROM sites) s, (SELECT count(*) FROM site_links) l');
  console.log(`Done. sites=${c.s}, site_links=${c.l}`);
})().catch(e => { console.error(e.message); process.exit(1); }).finally(() => pool.end());
