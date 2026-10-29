'use strict';
// Maps Salesforce CR events onto calendar site rows.
// Order of trust: CR number cited in a calendar cell > saved alias > site name in the Subject.
// Anything ambiguous or unknown is returned unmatched (with candidates) rather than guessed.

const STOP = new Set(['a','the','of','and','co','inc','club','usa','canada','rtp','rms','ril','casepick']);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Subjects arrive double-encoded (UTF-8 read as latin-1) for non-ASCII names, e.g. "HjÃ¤rtat".
function fixMojibake(s) {
  s = String(s || '');
  if (!/[ÃÂ]/.test(s)) return s;
  try { return Buffer.from(s, 'latin1').toString('utf8'); } catch (e) { return s; }
}

function crnKey(n) { return String(n || '').replace(/^0+/, ''); }

// crn -> [{tab, site}] from "CRN#00240291" notes already typed into calendar cells.
function buildCrnIndex(sitesByTab) {
  const idx = {};
  Object.keys(sitesByTab).forEach(tab => {
    sitesByTab[tab].forEach(row => {
      const seen = new Set();
      Object.values(row.cells || {}).forEach(cell => {
        const re = /CRN\s*#?\s*0*(\d{5,8})/gi;
        let m;
        while ((m = re.exec(String(cell)))) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          (idx[m[1]] = idx[m[1]] || []).push({ tab, site: row.site });
        }
      });
    });
  });
  return idx;
}

// Advance Automations tab = 'rtp': RTP, TTP, Relay.  Automation Essentials tab = 'rms': RIL, RMS, RA, Casepick.
const PRODUCT_TAB = { rtp:'rtp', ttp:'rtp', relay:'rtp', ril:'rms', rms:'rms', ra:'rms', casepick:'rms' };

// Salesforce Case.Product_Type__c -> tab (null for anything else, e.g. "Shuttle").
function productTab(product) { return PRODUCT_TAB[norm(product)] || null; }

function tabHint(subject) {
  const s = ' ' + norm(subject) + ' ';
  if (/ (rms|ril|ra|casepick) /.test(s)) return 'rms';
  if (/ (rtp|ttp|relay) /.test(s)) return 'rtp';
  return null;
}

function siteTokens(site) {
  const t = norm(site).split(' ').filter(Boolean);
  const keep = t.filter(x => !STOP.has(x));
  // Nothing distinctive left (e.g. "H&M Canada" -> h, m): fall back to every word.
  return keep.some(x => x.length >= 3) ? keep : t;
}

function uniq(list) {
  const seen = new Set();
  return list.filter(m => { const k = m.tab + '::' + m.site; if (seen.has(k)) return false; seen.add(k); return true; });
}

// sitesByTab: { rtp:[{site,cells}], rms:[...] }   aliases: [{alias, tab, site}]
function matchCRs(crs, sitesByTab, aliases) {
  const all = [];
  Object.keys(sitesByTab).forEach(tab => sitesByTab[tab].forEach(r => all.push({ tab, site: r.site, n: norm(r.site), tok: siteTokens(r.site) })));
  const crnIdx = buildCrnIndex(sitesByTab);
  const aliasList = (aliases || []).map(a => ({ n: norm(a.alias), tab: a.tab, site: a.site })).filter(a => a.n);

  // Resolve one piece of text (the SF account name, or the Subject) to calendar rows.
  function resolve(text) {
    const res = { matches: [], matchedBy: null, candidates: [] };
    const padded = ' ' + norm(text) + ' ';
    if (padded.trim() === '') return res;

    const byAlias = aliasList.filter(a => padded.includes(' ' + a.n + ' '));
    if (byAlias.length) {
      const longest = Math.max.apply(null, byAlias.map(a => a.n.length));
      res.matches = uniq(byAlias.filter(a => a.n.length === longest).map(a => ({ tab: a.tab, site: a.site })));
      res.matchedBy = 'alias';
      return res;
    }

    // Whole-phrase name match; the longest name wins ("Walmart Mexico" beats "Walmart").
    let hits = all.filter(s => s.n && padded.includes(' ' + s.n + ' '));
    if (hits.length) {
      const longest = Math.max.apply(null, hits.map(s => s.n.length));
      hits = hits.filter(s => s.n.length === longest);
    } else {
      // Token overlap: every word of 3+ letters in the site name must appear in the text
      // (so "Sam's ATL" never matches a "Sam's Club(LAX)" CR); 1-2 letter words ("s", "m") are noise.
      const textTok = new Set(norm(text).split(' '));
      const scored = all.map(s => {
        const need = s.tok.filter(t => t.length >= 3);
        const got = need.filter(t => textTok.has(t));
        return { s, h: got.length, sc: need.length ? got.length / need.length : 0, ok: need.length > 0 && got.length === need.length };
      }).filter(x => x.ok);
      if (scored.length) {
        const best = scored.reduce((m, x) => Math.max(m, x.h * 10 + x.sc), 0);
        hits = scored.filter(x => x.h * 10 + x.sc === best).map(x => x.s);
      }
    }
    if (!hits.length) return res;

    const cands = uniq(hits.map(s => ({ tab: s.tab, site: s.site })));
    // Same site name on both tabs is fine (chip shows on both); different sites is ambiguous.
    const distinct = new Set(cands.map(c => norm(c.site)));
    if (distinct.size === 1 && hits.every(s => s.n === hits[0].n)) { res.matches = cands; res.matchedBy = 'name'; }
    else res.candidates = cands;
    return res;
  }

  return crs.map(cr => {
    const subject = fixMojibake(cr.subject);
    const account = fixMojibake(cr.account);
    const out = Object.assign({}, cr, { subject, account, matches: [], matchedBy: null, candidates: [] });

    const byCrn = crnIdx[crnKey(cr.crNumber)];
    if (byCrn && byCrn.length) { out.matches = uniq(byCrn); out.matchedBy = 'crn'; return out; }

    // The Salesforce account is the clean key; the Subject is only a fallback.
    const r = resolve(account);
    const hit = (r.matches.length || r.candidates.length) ? r : resolve(subject);

    // The CR's product decides the tab (Advance Automations vs Automation Essentials).
    const tab = productTab(cr.product) || tabHint(subject);
    out.tab = tab;
    const onTab = list => list.filter(m => m.tab === tab);
    if (tab && hit.matches.length) {
      // Same customer, other product: show it on its own tab even if the sheet only has the site on the other one.
      const here = onTab(hit.matches);
      hit.matches = here.length ? here
        : uniq(hit.matches.map(m => ({ tab, site: m.site, fromSalesforce: true })));
    } else if (tab && hit.candidates.length && onTab(hit.candidates).length) {
      hit.candidates = onTab(hit.candidates);
      const d = new Set(hit.candidates.map(c => norm(c.site)));
      if (d.size === 1) { hit.matches = hit.candidates; hit.candidates = []; hit.matchedBy = hit.matchedBy || 'name'; }
    }
    out.matches = hit.matches; out.matchedBy = hit.matchedBy; out.candidates = hit.candidates;
    return out;
  });
}

// Subjects look like "<activity>-<customer>(<location>)", but activities contain hyphens too
// ("7.4.0.49-HF8"). Cut at the last hyphen before the first word of the customer name.
function activityOf(subject, sites) {
  subject = String(subject || '');
  const lower = subject.toLowerCase();
  let pos = -1;
  (sites || []).forEach(site => {
    const first = String(site).trim().split(/\s+/)[0].toLowerCase();
    const j = first ? lower.indexOf(first) : -1;
    if (j > 0 && (pos < 0 || j < pos)) pos = j;
    siteTokens(site).filter(t => t.length >= 3).forEach(t => {
      const i = lower.search(new RegExp('(^|[^a-z0-9])' + t.replace(/[^a-z0-9]/g, '') + '(?![a-z0-9])'));
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    });
  });
  const cut = pos > 0 ? lower.lastIndexOf('-', pos) : lower.indexOf('-');
  const text = (cut > 0 ? subject.slice(0, cut) : subject).replace(/[\s|\-]+$/, '').trim();
  return text || subject;
}

// Prefill for the alias box in the review list: the text after the activity name.
function aliasHint(subject) {
  const i = String(subject).indexOf('-');
  return i >= 0 ? subject.slice(i + 1).replace(/\s*\(.*$/, '').trim() : '';
}

module.exports = { matchCRs, aliasHint, activityOf, tabHint, productTab, norm, fixMojibake };
