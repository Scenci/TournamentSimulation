'use strict';

/**
 * Build steam/snapshot.json from Valve's public endpoints.
 *
 * This script is the ONLY thing in the project that talks to Steam. The app
 * itself reads the snapshot, which keeps it reproducible, offline-capable, and
 * free of rate limits — and sidesteps the fact that these endpoints send no
 * CORS header, so a browser could never call them anyway.
 *
 * Note we do NOT use SteamDB: it has no public API and its FAQ explicitly
 * prohibits automated access. Review counts originate at Valve regardless.
 *
 *   node steam/fetch-steam.js                        the curated field below
 *   node steam/fetch-steam.js --chart 30             top 30 most-played instead
 *
 *   --chart N         pull the N most-played games rather than the curated list
 *   --min-reviews N   drop anything with fewer total reviews
 *                     (default 0 curated, 5000 chart — a curated pick is
 *                      deliberate, so it is not second-guessed on sample size)
 *   --out PATH        output file (default steam/snapshot.json)
 *   --delay MS        pause between requests (default 250)
 */

const fs = require('fs');
const path = require('path');

const CHARTS = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';
const DETAILS = 'https://store.steampowered.com/api/appdetails';
const REVIEWS = 'https://store.steampowered.com/appreviews';

/**
 * The default field. `appids` may list more than one entry, in which case the
 * review counts are summed and they compete as a single entrant.
 *
 * Nothing in the default field merges any more, and that is deliberate: a merge
 * produces a weighted average describing neither game. Bundling Subnautica with
 * its weaker Early Access sequel dragged it from 97.04% to 95.52%, and merging
 * RimWorld's two DLCs hid a genuine ~10-point gap between them. Only merge when
 * the parts really are one competitor.
 *
 * Names are chosen to match DEFAULT_ROSTER in sim.js so weights key cleanly onto
 * the built-in roster.
 */
const DEFAULT_TARGETS = [
  { name: 'Onimusha', appids: [2638890] },                       // Way of the Sword
  { name: 'Crimson Desert', appids: [3321460] },                 // Enhanced
  { name: 'They Are Billions', appids: [644930] },
  { name: 'RimWorld: Odyssey', appids: [3022790] },
  { name: 'RimWorld: Anomaly', appids: [2380740] },
  { name: 'The Blood of Dawnwalker', appids: [3751260] },
  { name: 'KCD2', appids: [1771300] },                           // Kingdom Come: Deliverance II
  { name: 'STALKER 2', appids: [1643320] },                      // Heart of Chornobyl
  { name: 'The Sinking City 2', appids: [2825860] },
  { name: 'Project PITT', appids: [4026250] },
  { name: 'Subnautica', appids: [264710] },
];

// Things that ride the most-played chart but are not tournament entrants.
// Only applied in --chart mode; a curated pick is taken at its word.
const NAME_BLOCKLIST = /playtest|\bdemo\b|\bbeta\b|dedicated server|\bserver\b|\bSDK\b|soundtrack|trailer|benchmark/i;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return /^\d+$/.test(v) ? Number(v) : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tournament-sim/1.0 (personal project)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

/** Review totals for one appid, or null if it has none. */
async function reviewsFor(appid) {
  const j = await getJson(REVIEWS + '/' + appid + '?json=1&language=all&purchase_type=all&num_per_page=0');
  const q = j.query_summary;
  if (!q || !q.total_reviews) return null;
  return { positive: q.total_positive, negative: q.total_negative, total: q.total_reviews, desc: q.review_score_desc };
}

async function nameFor(appid) {
  const d = await getJson(DETAILS + '?appids=' + appid + '&filters=basic');
  const e = d[String(appid)];
  if (!e || !e.success || !e.data) return null;
  return { name: e.data.name, type: e.data.type };
}

async function main() {
  const chartN = Number(arg('chart', 0));
  const useChart = chartN > 0;
  const minReviews = Number(arg('min-reviews', useChart ? 5000 : 0));
  const delay = Number(arg('delay', 250));
  const out = path.resolve(__dirname, '..', String(arg('out', 'steam/snapshot.json')));

  let targets;
  if (useChart) {
    console.log('Fetching most-played chart…');
    const chart = await getJson(CHARTS);
    const ranks = ((chart.response && chart.response.ranks) || []).slice(0, chartN);
    if (!ranks.length) throw new Error('Charts endpoint returned no entries.');
    targets = ranks.map((r) => ({ name: null, appids: [r.appid], peakPlayers: r.peak_in_game || null }));
    console.log('  got ' + ranks.length + ' candidates\n');
  } else {
    targets = DEFAULT_TARGETS;
    console.log('Curated field: ' + targets.length + ' entrants\n');
  }

  const games = [];
  const skipped = [];

  for (const t of targets) {
    // Merge every appid in the entry into one competitor.
    let positive = 0;
    let negative = 0;
    let total = 0;
    let desc = null;
    let label = t.name;
    let bad = null;
    const parts = [];

    for (const id of t.appids) {
      let meta = null;
      try {
        meta = await nameFor(id);
      } catch (err) { /* name is optional when curated supplies one */ }
      await sleep(delay);

      if (!label && meta) label = meta.name;
      if (useChart) {
        if (!meta) { bad = 'no name'; break; }
        if (meta.type && meta.type !== 'game') { bad = 'type=' + meta.type; break; }
        if (NAME_BLOCKLIST.test(meta.name)) { bad = 'blocked name'; break; }
      }

      let r = null;
      try {
        r = await reviewsFor(id);
      } catch (err) { bad = 'appreviews failed: ' + err.message; }
      await sleep(delay);

      if (!r) { bad = bad || 'no reviews for appid ' + id; break; }
      positive += r.positive;
      negative += r.negative;
      total += r.total;
      desc = desc || r.desc;
      parts.push({ appid: id, name: (meta && meta.name) || String(id), total: r.total });
    }

    if (bad) { skipped.push({ name: label || t.appids[0], why: bad }); continue; }
    if (total < minReviews) {
      skipped.push({ name: label, why: total + ' reviews < ' + minReviews });
      continue;
    }

    // Raw counts only. Wilson and the matchup weights are derived at load time so
    // the tuning knobs stay live without needing a re-fetch.
    games.push({
      name: label,
      appids: t.appids,
      positive,
      negative,
      total,
      scoreDesc: parts.length > 1 ? 'Combined' : desc,
      peakPlayers: t.peakPlayers || null,
      merged: parts.length > 1 ? parts.map((p) => p.name + ' (' + p.total.toLocaleString() + ')') : undefined,
    });

    const pct = ((positive / total) * 100).toFixed(2);
    console.log('  ✓ ' + label.slice(0, 30).padEnd(32) + String(total).padStart(9) + ' reviews  ' + pct.padStart(6) + '%'
      + (parts.length > 1 ? '   ← ' + parts.map((p) => p.name).join(' + ') : ''));
  }

  if (games.length < 4) throw new Error('Only ' + games.length + ' entrants survived; need at least 4.');

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    source: 'steam-web-api',
    field: useChart ? 'most-played-' + chartN : 'curated',
    params: { minReviews },
    games,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');

  console.log('\n' + games.length + ' entrants written to ' + path.relative(process.cwd(), out));
  if (skipped.length) {
    console.log('\nSkipped ' + skipped.length + ':');
    for (const s of skipped) console.log('  - ' + s.name + ' (' + s.why + ')');
  }
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message);
  process.exit(1);
});
