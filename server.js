'use strict';

/**
 * Zero-dependency static server + simulation API.
 *   GET /                     -> the app
 *   GET /api/simulate?...     -> a full simulated tournament as JSON
 *        seed=<uint32>        (optional; omit for a fresh random tournament)
 *        bestOf=1|3|5|7       (default 3)
 *        roster=A|B|C         (optional; pipe-separated, 4-32 entrants)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { simulate, DEFAULT_ROSTER } = require('./sim');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  // POST carries the matchup weight table, which is far too big for a query
  // string (n entrants means n*(n-1)/2 pairings).
  if (url.pathname === '/api/simulate' && req.method === 'POST') {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 4e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { sendJson(res, 413, { error: 'Payload too large.' }); return; }
      let o;
      try {
        o = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Malformed JSON body.' });
        return;
      }
      const roster = Array.isArray(o.roster)
        ? o.roster.map((s) => String(s).trim()).filter(Boolean).slice(0, 32)
        : null;
      if (roster && roster.length < 4) {
        sendJson(res, 400, { error: 'Need at least 4 entrants.' });
        return;
      }
      try {
        sendJson(res, 200, simulate({ seed: o.seed, bestOf: o.bestOf, roster, weights: o.weights }));
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
    });
    return;
  }

  if (url.pathname === '/api/simulate') {
    const q = url.searchParams;
    const rosterRaw = q.get('roster');
    const roster = rosterRaw
      ? rosterRaw.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 32)
      : null;

    if (roster && roster.length < 4) {
      sendJson(res, 400, { error: 'Need at least 4 entrants.' });
      return;
    }
    try {
      sendJson(res, 200, simulate({ seed: q.get('seed'), bestOf: q.get('bestOf'), roster }));
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
    return;
  }

  /**
   * Proof that the weights are actually driving the coin flips: run the same
   * configuration many times headlessly and report, for each weighted pairing,
   * the rate actually observed across every game played versus the rate you set.
   */
  if (url.pathname === '/api/verify' && req.method === 'POST') {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 4e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { sendJson(res, 413, { error: 'Payload too large.' }); return; }
      let o;
      try {
        o = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Malformed JSON body.' });
        return;
      }

      const weights = Array.isArray(o.weights) ? o.weights : [];
      if (!weights.length) { sendJson(res, 200, { runs: 0, pairs: [] }); return; }

      const roster = Array.isArray(o.roster) && o.roster.length >= 4
        ? o.roster.map((s) => String(s).trim()).filter(Boolean).slice(0, 32)
        : null;
      const runs = Math.max(100, Math.min(20000, Number(o.runs) || 2000));

      // canonical key per pairing, ordered so the tally is unambiguous
      const want = new Map();
      for (const row of weights) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const [a, b, pct] = row;
        if (typeof a !== 'string' || typeof b !== 'string' || a === b) continue;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const setPct = a < b ? Number(pct) : 100 - Number(pct);
        want.set(lo + '\u0000' + hi, { lo, hi, setPct, games: 0, loWins: 0, series: 0 });
      }

      const started = Date.now();
      try {
        for (let i = 0; i < runs; i++) {
          const sim = simulate({ bestOf: o.bestOf, roster, weights });
          for (const ev of sim.events) {
            if (ev.type !== 'match') continue;
            const lo = ev.a < ev.b ? ev.a : ev.b;
            const hi = ev.a < ev.b ? ev.b : ev.a;
            const rec = want.get(lo + '\u0000' + hi);
            if (!rec) continue;
            rec.series++;
            for (const g of ev.games) {
              rec.games++;
              if (g === lo) rec.loWins++;
            }
          }
        }
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
        return;
      }

      const pairs = [...want.values()]
        .map((r) => ({
          a: r.lo,
          b: r.hi,
          setPct: r.setPct,
          observedPct: r.games ? (r.loWins / r.games) * 100 : null,
          games: r.games,
          series: r.series,
        }))
        .sort((x, y) => y.games - x.games);

      sendJson(res, 200, { runs, ms: Date.now() - started, pairs });
    });
    return;
  }

  if (url.pathname === '/api/roster') {
    sendJson(res, 200, { roster: DEFAULT_ROSTER });
    return;
  }

  // ---- static files, confined to public/ ----
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('Tournament sim running at  http://localhost:' + PORT);
});
