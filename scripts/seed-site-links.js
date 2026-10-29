// Creates site_links (if missing) and adds a blank row for every site that
// doesn't have one yet. Safe to re-run; never overwrites existing links.
require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_links (
      site_id        INT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      tab            TEXT NOT NULL,
      site           TEXT NOT NULL,
      pl             TEXT NOT NULL DEFAULT '',
      tower          TEXT NOT NULL DEFAULT '',
      md_dashboard   TEXT NOT NULL DEFAULT '',
      butler_server  TEXT NOT NULL DEFAULT '',
      platform_url   TEXT NOT NULL DEFAULT '',
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rowCount } = await pool.query(
    `INSERT INTO site_links (site_id, tab, site, pl)
     SELECT id, tab, site, pl FROM sites
     ON CONFLICT (site_id) DO NOTHING`);
  const { rows: [c] } = await pool.query('SELECT count(*) n FROM site_links');
  console.log(`Inserted ${rowCount} new rows; site_links now has ${c.n} rows.`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
