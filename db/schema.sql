-- GO Events Calendar — Postgres schema
-- Replaces the three Google Sheets tabs (RTP/TTP, RMS/RIL, GO_Meta) and the
-- GO_Analytics tab. One row per site per tab; weekly cell values live in
-- site_weeks so new week columns never require a schema change.

CREATE TABLE IF NOT EXISTS sites (
  id            SERIAL PRIMARY KEY,
  tab           TEXT NOT NULL,              -- 'rtp' | 'rms'
  site          TEXT NOT NULL,
  pl            TEXT NOT NULL DEFAULT '',
  ver           TEXT NOT NULL DEFAULT '',
  cspoc         TEXT NOT NULL DEFAULT '',
  url_tower     TEXT NOT NULL DEFAULT '',
  url_md        TEXT NOT NULL DEFAULT '',
  url_butler    TEXT NOT NULL DEFAULT '',
  url_platform  TEXT NOT NULL DEFAULT '',
  row_order     INT NOT NULL DEFAULT 0,      -- preserves original sheet row order
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tab, site)
);

CREATE TABLE IF NOT EXISTS site_weeks (
  id       SERIAL PRIMARY KEY,
  site_id  INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  week     TEXT NOT NULL,                    -- e.g. 'Week 13'
  value    TEXT NOT NULL DEFAULT '',
  UNIQUE (site_id, week)
);

-- Generalized append-only event log — replaces the GO_Meta sheet, which
-- stored Audit / RedZone / WarRoom / Pending-approval rows side by side.
CREATE TABLE IF NOT EXISTS meta_log (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,                -- 'Audit' | 'RZ' | 'WR' | 'WR_CANCEL' | 'PENDING'
  tab          TEXT,
  site         TEXT,
  pending_id   TEXT,                         -- only set for kind = 'PENDING'
  action       TEXT,                         -- Audit action label / 'RedZone' / 'WarRoom' / 'Cancelled'
  field        TEXT,                         -- audit field / pending week label
  val1         TEXT,                         -- oldVal / RZ flag / WR start / pending newValue
  val2         TEXT,                         -- newVal / WR end / pending oldValue
  editor_email TEXT NOT NULL DEFAULT '',
  editor_name  TEXT NOT NULL DEFAULT '',
  status       TEXT,                         -- 'pending' | 'approved' | 'rejected' (PENDING rows only)
  approver     TEXT,
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_log_kind_idx ON meta_log (kind);
CREATE INDEX IF NOT EXISTS meta_log_tab_site_idx ON meta_log (tab, site);
CREATE INDEX IF NOT EXISTS meta_log_pending_id_idx ON meta_log (pending_id);

-- Replaces the GO_Analytics sheet.
CREATE TABLE IF NOT EXISTS analytics_events (
  id     SERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  email  TEXT NOT NULL,
  name   TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,                      -- 'page_view' | other action names
  tab    TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS analytics_events_action_idx ON analytics_events (action);
CREATE INDEX IF NOT EXISTS analytics_events_email_idx ON analytics_events (email);
