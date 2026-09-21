#!/usr/bin/env node
'use strict';
// One-time migration: reads the live Google Sheet (RTP/TTP tab, RMS/RIL tab,
// GO_Meta event log, GO_Analytics) using the existing service-account
// credentials, and loads everything into Postgres. Safe to re-run — sites
// and week cells are upserted; meta/analytics rows are only inserted once
// per run, so re-running after a partial failure will duplicate log rows.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const pool = require('../db/pool');

const SHEET_ID        = process.env.SHEET_ID;
const RTP_SHEET       = process.env.RTP_SHEET  || 'RTP/TTP Release Calender';
const RMS_SHEET       = process.env.RMS_SHEET  || 'RMS/RIL/CasePick Release Calender';
const META_SHEET      = process.env.META_SHEET || 'GO_Meta';
const ANALYTICS_SHEET = 'GO_Analytics';

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_KEY_FILE || './credentials/service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getRange(sheets, sheetName, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'${range ? '!' + range : ''}`,
  });
  return res.data.values || [];
}

function toTimestamp(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// Mirrors readSheet()'s column-detection logic in server/server.js so the
// imported rows match exactly what the app already parses out of the sheet.
function parseSiteRows(rows) {
  if (!rows.length) return [];
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === 'Site Name') { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = 0;

  const headers = rows[headerIdx];
  let plCol = -1, verCol = 2, cspocCol = -1;
  const urlCols = { tower: -1, md: -1, butler: -1, platform: -1 };
  const weekCols = {};

  headers.forEach((h, c) => {
    const hs = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (hs === 'site name' || hs === 'site') return;
    if (hs === 'product line' || hs === 'pl') plCol = c;
    else if (hs === 'version' || hs === 'ver' || hs === 'current version' || hs === 'sw version') verCol = c;
    else if (hs === 'cs poc' || hs === 'cspoc' || hs === 'cs-poc') cspocCol = c;
    else if (hs === 'tower url') urlCols.tower = c;
    else if (hs === 'md url') urlCols.md = c;
    else if (hs === 'butler server url' || hs === 'butler url') urlCols.butler = c;
    else if (hs === 'platform url') urlCols.platform = c;
    else if (/^week\s*\d+/i.test(hs)) weekCols[String(h).trim()] = c;
  });

  const sites = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const site = String(row[0] || '').trim();
    if (!site) continue;

    const cells = {};
    Object.entries(weekCols).forEach(([wk, ci]) => {
      const v = String(row[ci] || '').trim();
      if (v) cells[wk] = v;
    });

    sites.push({
      site,
      pl:    plCol >= 0    ? String(row[plCol] || '').trim()    : String(row[1] || '').trim(),
      ver:   String(row[verCol] || '').trim(),
      cspoc: cspocCol >= 0 ? String(row[cspocCol] || '').trim() : '',
      urls: {
        tower:    urlCols.tower >= 0    ? String(row[urlCols.tower] || '')    : '',
        md:       urlCols.md >= 0       ? String(row[urlCols.md] || '')       : '',
        butler:   urlCols.butler >= 0   ? String(row[urlCols.butler] || '')   : '',
        platform: urlCols.platform >= 0 ? String(row[urlCols.platform] || '') : '',
      },
      cells,
    });
  }
  return sites;
}

async function importTab(sheets, tab, sheetName) {
  const rows  = await getRange(sheets, sheetName);
  const sites = parseSiteRows(rows);
  console.log(`  [${tab}] ${sites.length} sites from "${sheetName}"`);

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const { rows: [siteRow] } = await pool.query(
      `INSERT INTO sites (tab, site, pl, ver, cspoc, url_tower, url_md, url_butler, url_platform, row_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tab, site) DO UPDATE SET
         pl=$3, ver=$4, cspoc=$5, url_tower=$6, url_md=$7, url_butler=$8, url_platform=$9,
         row_order=$10, updated_at=now()
       RETURNING id`,
      [tab, s.site, s.pl, s.ver, s.cspoc, s.urls.tower, s.urls.md, s.urls.butler, s.urls.platform, i]
    );
    const siteId = siteRow.id;
    for (const [week, value] of Object.entries(s.cells)) {
      await pool.query(
        `INSERT INTO site_weeks (site_id, week, value) VALUES ($1,$2,$3)
         ON CONFLICT (site_id, week) DO UPDATE SET value=$3`,
        [siteId, week, value]
      );
    }
  }
}

// GO_Meta rows are variable-width depending on kind — see the append calls
// in the pre-migration server/server.js for the exact column layout.
async function importMeta(sheets) {
  let rows = [];
  try { rows = await getRange(sheets, META_SHEET); }
  catch (e) { console.log(`  [meta] "${META_SHEET}" not found, skipping`); return; }
  console.log(`  [meta] ${rows.length} rows`);

  let n = 0;
  for (const r of rows) {
    const kind = String(r[0] || '').trim();
    if (kind === 'Audit') {
      await pool.query(
        `INSERT INTO meta_log (kind, tab, site, action, field, val1, val2, editor_email, editor_name, created_at)
         VALUES ('Audit',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r[1] || '', r[2] || '', r[3] || '', r[4] || '',
         ...splitChange(r[5]), r[6] || '', r[7] || '', toTimestamp(r[8])]
      );
    } else if (kind === 'RZ') {
      await pool.query(
        `INSERT INTO meta_log (kind, tab, site, action, val1, editor_email, created_at)
         VALUES ('RZ',$1,$2,$3,$4,$5,$6)`,
        [r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[6] || '', toTimestamp(r[7])]
      );
    } else if (kind === 'WR') {
      await pool.query(
        `INSERT INTO meta_log (kind, tab, site, action, val1, val2, editor_email, created_at)
         VALUES ('WR',$1,$2,$3,$4,$5,$6,$7)`,
        [r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '', r[6] || '', toTimestamp(r[7])]
      );
    } else if (kind === 'WR_CANCEL') {
      await pool.query(
        `INSERT INTO meta_log (kind, tab, site, action, editor_email, created_at)
         VALUES ('WR_CANCEL',$1,$2,$3,$4,$5)`,
        [r[1] || '', r[2] || '', r[3] || '', r[6] || '', toTimestamp(r[7])]
      );
    } else if (kind === 'PENDING') {
      await pool.query(
        `INSERT INTO meta_log (kind, pending_id, tab, site, field, val1, val2, editor_email, editor_name, status, approver, approved_at, created_at)
         VALUES ('PENDING',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '', r[6] || '',
         r[7] || '', r[8] || '', r[10] || 'pending', r[11] || null, toTimestamp(r[12]), toTimestamp(r[9])]
      );
    } else {
      continue;
    }
    n++;
  }
  console.log(`  [meta] imported ${n} rows`);
}

// Audit rows stored the change as a single "oldVal -> newVal" string.
function splitChange(v) {
  const s = String(v || '');
  if (s.includes(' -> ')) {
    const idx = s.indexOf(' -> ');
    return [s.slice(0, idx), s.slice(idx + 4)];
  }
  return [s, ''];
}

async function importAnalytics(sheets) {
  let rows = [];
  try { rows = await getRange(sheets, ANALYTICS_SHEET); }
  catch (e) { console.log(`  [analytics] "${ANALYTICS_SHEET}" not found, skipping`); return; }
  rows = rows.slice(1); // header row
  console.log(`  [analytics] ${rows.length} rows`);

  let n = 0;
  for (const r of rows) {
    const ts = toTimestamp(r[0]);
    if (!ts || !r[1]) continue;
    await pool.query(
      `INSERT INTO analytics_events (ts, email, name, action, tab, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ts, r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '']
    );
    n++;
  }
  console.log(`  [analytics] imported ${n} rows`);
}

async function main() {
  if (!SHEET_ID || SHEET_ID === 'PASTE_YOUR_COPY_SHEET_ID_HERE') {
    console.error('✗ SHEET_ID not set in .env — point it at the sheet to migrate from');
    process.exit(1);
  }
  const sheets = getSheetsClient();

  console.log('\nMigrating Google Sheet → Postgres');
  console.log(`  Sheet ID: ${SHEET_ID}\n`);

  await importTab(sheets, 'rtp', RTP_SHEET);
  await importTab(sheets, 'rms', RMS_SHEET);
  await importMeta(sheets);
  await importAnalytics(sheets);

  console.log('\n✓ Migration complete\n');
  await pool.end();
}

main().catch(err => {
  console.error('\n✗ Migration failed:', err.message);
  process.exit(1);
});
