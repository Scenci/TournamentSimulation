'use strict';

/**
 * Tournament simulation engine - zero dependencies.
 *
 * Models a STANDARD double-elimination bracket: fixed slots, standard seeding
 * (so #1 and #2 can only meet in the final), and the conventional alternating
 * losers bracket - "minor" rounds where losers-side survivors pair off, and
 * "major" rounds where they meet a fresh batch dropping down from the winners
 * side. Because the structure is fixed, every match knows which two matches
 * feed it, which is what lets the client draw a real bracket tree.
 *
 * Returns the bracket skeleton (nodes + rounds) and a flat event timeline the
 * client replays at whatever speed it likes.
 */

const DEFAULT_ROSTER = [
  'Onimusha',
  'Crimson Desert',
  'They Are Billions',
  'RimWorld: Odyssey',
  'RimWorld: Anomaly',
  'The Blood of Dawnwalker',
  'KCD2',
  'STALKER 2',
  'The Sinking City 2',
  'Project PITT',
  'Subnautica',
  'Expedition 33',
  'Dungeon Settlers',
];

/** mulberry32 - small, fast, seedable. Same seed always replays the same tournament. */
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Matchup weights: per-GAME win probability for a specific pairing.
 *
 * Supplied as triples [nameA, nameB, pct] meaning "A wins pct% of games against
 * B". Both directions are stored so lookups are symmetric and can never
 * disagree - setting A>B to 54 defines B>A as 46 by construction. Anything
 * unspecified stays a 50/50 coin flip.
 *
 * Weights are deliberately allowed to be non-transitive: A can beat B, B beat
 * C, and C beat A. Real matchup charts look like that.
 */
function buildWeights(list) {
  const W = Object.create(null);
  if (!Array.isArray(list)) return W;
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const a = row[0];
    const b = row[1];
    const p = Number(row[2]);
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) continue;
    if (!Number.isFinite(p)) continue;
    const pct = Math.max(0, Math.min(100, p));
    (W[a] || (W[a] = Object.create(null)))[b] = pct;
    (W[b] || (W[b] = Object.create(null)))[a] = 100 - pct;
  }
  return W;
}

/** Probability that `a` takes a single game off `b`. */
function probOf(W, a, b) {
  const row = W[a];
  const v = row && row[b];
  return v === undefined ? 0.5 : v / 100;
}

/**
 * Wilson score lower bound - the conservative estimate of a true positive rate
 * given `pos` successes out of `total`, at ~95% confidence by default.
 *
 * Raw pos/total is a trap for ranking: 9 positive out of 10 scores 90% and would
 * outrank a game with 950,000 out of a million. The Wilson bound asks instead
 * "what is the lowest rate consistent with this sample?", so a tiny sample is
 * pulled hard toward 50% while a huge one barely moves. 9/10 -> 59.6%,
 * 9500/10000 -> 94.6%.
 */
function wilsonLower(pos, total, z) {
  const n = Number(total) || 0;
  if (n <= 0) return 0;
  const zz = z === undefined ? 1.96 : z;
  const p = Math.max(0, Math.min(n, Number(pos) || 0)) / n;
  const z2 = zz * zz;
  return (p + z2 / (2 * n) - zz * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

const logit = (x) => Math.log(x / (1 - x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Turn per-entrant quality scores into pairwise per-game matchup weights.
 *
 * P(a beats b) = sigmoid(k * (logit(score_a) - logit(score_b))), i.e. a
 * Bradley-Terry model on log-odds, with two knobs that matter a great deal:
 *
 *   k     "competitiveness". At k=1 real review spreads are brutal - the widest
 *         pairing in a live top-16 field comes out at 96% per game, which is
 *         99.6% over a Bo3, so the bracket is decided at seeding. Around 0.3
 *         keeps favourites favoured while leaving genuine upset room. Remember a
 *         series already amplifies any per-game edge.
 *   clamp floor/ceiling so no matchup is ever a foregone conclusion.
 *
 * Returns the same [a, b, pct] triples `buildWeights` consumes, one per pairing,
 * so this drops straight into simulate({ weights }).
 */
function weightsFromScores(scores, opts) {
  opts = opts || {};
  const k = Number.isFinite(Number(opts.k)) ? Number(opts.k) : 0.3;
  const clamp = Math.max(0, Math.min(0.5, Number.isFinite(Number(opts.clamp)) ? Number(opts.clamp) : 0.25));
  const lo = clamp;
  const hi = 1 - clamp;

  // guard the logit against 0/1, which would blow up to +/-Infinity
  const list = (scores || [])
    .filter((s) => s && typeof s.name === 'string' && Number.isFinite(Number(s.score)))
    .map((s) => ({ name: s.name, l: logit(Math.max(0.001, Math.min(0.999, Number(s.score)))) }));

  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const p = Math.max(lo, Math.min(hi, sigmoid(k * (list[i].l - list[j].l))));
      out.push([list[i].name, list[j].name, Math.round(p * 100)]);
    }
  }
  return out;
}

/**
 * Standard bracket seeding order for a given size, e.g. size 8 ->
 * [1,8,4,5,2,7,3,6]. Pairing adjacent entries gives the classic first round
 * where the top seed draws the bottom seed and the favourites are kept apart.
 */
function seedOrder(size) {
  let r = [1];
  while (r.length < size) {
    const m = r.length * 2 + 1;
    const out = [];
    for (const s of r) out.push(s, m - s);
    r = out;
  }
  return r;
}

function simulate(opts) {
  opts = opts || {};
  const roster = (opts.roster && opts.roster.length >= 4 ? opts.roster : DEFAULT_ROSTER).slice(0, 32);
  const bestOf = [1, 3, 5, 7].indexOf(Number(opts.bestOf)) !== -1 ? Number(opts.bestOf) : 3;
  const hasSeed = opts.seed !== undefined && opts.seed !== null && opts.seed !== '' && Number.isFinite(Number(opts.seed));
  const seed = hasSeed ? Number(opts.seed) >>> 0 : (Math.random() * 4294967296) >>> 0;

  const rand = rngFrom(seed);
  const needed = Math.ceil(bestOf / 2); // games required to take a series
  const matchupW = buildWeights(opts.weights);

  // ---- randomized seeding ----
  const field = shuffle(roster.slice(), rand);
  const seedOf = new Map(field.map((n, i) => [n, i + 1]));

  const stats = new Map(
    roster.map((n) => [n, { name: n, seed: seedOf.get(n), sw: 0, sl: 0, gw: 0, gl: 0, out: false }])
  );

  const events = [];
  const nodes = [];
  const roundMeta = [];
  let matchId = 0;

  const bracketSize = nextPow2(field.length);
  const wbRoundCount = Math.round(Math.log2(bracketSize));
  const order = seedOrder(bracketSize);
  const slots = order.map((s) => (s <= field.length ? field[s - 1] : null));
  const byeCount = bracketSize - field.length;

  events.push({
    type: 'seeding',
    field: field.map((n) => ({ name: n, seed: seedOf.get(n) })),
    bracketSize,
    byeCount,
    bestOf,
  });

  function snapshot() {
    const out = [];
    stats.forEach((s) => out.push({ name: s.name, seed: s.seed, sw: s.sw, sl: s.sl, gw: s.gw, gl: s.gl, out: s.out }));
    return out;
  }

  function addRound(key, bracket, name, kind) {
    roundMeta.push({ key, bracket, name, kind: kind || 'match' });
    events.push({ type: 'round', key, bracket, name });
  }

  /** A structural slot in the bracket: either a real series or a walkover. */
  function addNode(n) {
    nodes.push(n);
    return n;
  }

  /**
   * Play one best-of-N series. Each game is an independent draw at the pairing's
   * weight (50/50 unless a matchup weight says otherwise), so a series is the
   * usual binomial amplification: a per-game edge becomes a bigger series edge
   * the longer the series.
   */
  function series(node) {
    const a = node.a;
    const b = node.b;
    const p = probOf(matchupW, a, b);
    let sa = 0;
    let sb = 0;
    const games = [];
    while (sa < needed && sb < needed) {
      if (rand() < p) { sa++; games.push(a); } else { sb++; games.push(b); }
    }
    const aWon = sa > sb;
    const winner = aWon ? a : b;
    const loser = aWon ? b : a;
    const ws = aWon ? sa : sb;
    const ls = aWon ? sb : sa;

    const W = stats.get(winner);
    const L = stats.get(loser);
    W.sw++; L.sl++;
    W.gw += ws; W.gl += ls;
    L.gw += ls; L.gl += ws;

    const eliminated = L.sl >= 2;
    if (eliminated) L.out = true;

    node.winner = winner;
    node.loser = loser;

    events.push({
      type: 'match',
      id: node.id,
      roundKey: node.roundKey,
      a, b,
      aSeed: seedOf.get(a),
      bSeed: seedOf.get(b),
      games, // per-game winners, so the client can tick the series out live
      winner, loser,
      score: [ws, ls],
      sweep: ls === 0,
      odds: Math.round(p * 100), // per-game % for `a`; 50 means an even coin flip
      upset: seedOf.get(winner) > seedOf.get(loser),
      eliminated: eliminated ? loser : null,
      standings: snapshot(),
    });
    return winner;
  }

  /** Resolve one bracket position: a real series, a walkover, or an empty slot. */
  function resolve(node) {
    if (node.a && node.b) return series(node);
    const solo = node.a || node.b;
    if (!solo) return null;
    node.bye = true;
    node.winner = solo;
    events.push({ type: 'bye', id: node.id, roundKey: node.roundKey, player: solo, seed: seedOf.get(solo) });
    return solo;
  }

  // ---------------- winners bracket ----------------
  const wbLosers = {}; // round number -> losers in slot order (null where a bye)
  let cur = slots;
  let prevIds = slots.map(() => null);

  for (let r = 1; r <= wbRoundCount; r++) {
    const key = 'W' + r;
    const size = cur.length;
    const name =
      size === 2 ? 'Winners Final'
        : size === 4 ? 'Winners Semifinals'
          : size === 8 ? 'Winners Quarterfinals'
            : 'Winners Round ' + r;
    addRound(key, 'W', name);

    const winners = [];
    const losers = [];
    const ids = [];
    for (let i = 0; i < size / 2; i++) {
      const node = addNode({
        id: 'm' + ++matchId,
        roundKey: key,
        bracket: 'W',
        round: r,
        pos: i,
        a: cur[2 * i],
        b: cur[2 * i + 1],
        fromA: prevIds[2 * i],
        fromB: prevIds[2 * i + 1],
      });
      const w = resolve(node);
      winners.push(w);
      losers.push(node.loser || null);
      ids.push(node.id);
    }
    wbLosers[r] = losers;
    cur = winners;
    prevIds = ids;
  }

  const wbChamp = cur[0];
  const wbFinalId = prevIds[0];
  events.push({
    type: 'bracketChamp',
    bracket: 'W',
    player: wbChamp,
    record: [stats.get(wbChamp).sw, stats.get(wbChamp).sl],
  });

  // ---------------- losers bracket ----------------
  // Alternating structure: odd rounds pair losers-side survivors against each
  // other, even rounds feed in the batch that just dropped out of the winners
  // bracket. The drop batch is reversed against the survivors, the usual
  // heuristic for delaying rematches.
  const lbRoundCount = 2 * (wbRoundCount - 1);
  let lbCur = [];
  let lbPrevIds = [];

  for (let lr = 1; lr <= lbRoundCount; lr++) {
    const key = 'L' + lr;
    const major = lr % 2 === 0; // a batch drops down from the winners bracket
    const isFinal = lr === lbRoundCount;

    let pairs;      // [aName, bName]
    let feeders;    // [fromA, fromB] node ids (fromB null for a WB drop-in)
    let dropFrom;   // WB node ids the drop-ins arrive from, for edge drawing

    pairs = [];
    feeders = [];
    dropFrom = [];

    // Uneven bye counts can leave a round with an odd number of survivors, or
    // with fewer survivors than there are entrants dropping down. Size every
    // round by the larger side and let the leftovers take a walkover, so nobody
    // is silently dropped from the tournament.
    if (lr === 1) {
      const pool = wbLosers[1];
      const poolIds = nodes.filter((n) => n.roundKey === 'W1').map((n) => n.id);
      for (let i = 0; i < pool.length / 2; i++) {
        pairs.push([pool[2 * i] || null, pool[2 * i + 1] || null]);
        feeders.push([poolIds[2 * i] || null, poolIds[2 * i + 1] || null]);
        dropFrom.push(null);
      }
    } else if (major) {
      const wbRound = lr / 2 + 1;
      const drop = wbLosers[wbRound].slice().reverse();
      const dropIds = nodes.filter((n) => n.roundKey === 'W' + wbRound).map((n) => n.id).reverse();
      const count = Math.max(lbCur.length, drop.length);
      for (let i = 0; i < count; i++) {
        pairs.push([lbCur[i] || null, drop[i] || null]);
        feeders.push([lbPrevIds[i] || null, null]);
        dropFrom.push(dropIds[i] || null);
      }
    } else {
      for (let i = 0; i < Math.ceil(lbCur.length / 2); i++) {
        pairs.push([lbCur[2 * i] || null, lbCur[2 * i + 1] || null]);
        feeders.push([lbPrevIds[2 * i] || null, lbPrevIds[2 * i + 1] || null]);
        dropFrom.push(null);
      }
    }

    const name = isFinal ? 'Losers Final' : 'Losers Round ' + lr;
    addRound(key, 'L', name, major ? 'major' : 'minor');

    if (major) {
      const live = pairs.map((p) => p[1]).filter(Boolean);
      if (live.length) events.push({ type: 'drop', roundKey: key, players: live });
    }

    const winners = [];
    const ids = [];
    for (let i = 0; i < pairs.length; i++) {
      if (!pairs[i][0] && !pairs[i][1]) { winners.push(null); ids.push(null); continue; }
      const node = addNode({
        id: 'm' + ++matchId,
        roundKey: key,
        bracket: 'L',
        round: lr,
        pos: i,
        a: pairs[i][0],
        b: pairs[i][1],
        fromA: feeders[i][0],
        fromB: feeders[i][1],
        dropFrom: dropFrom[i] || null,
      });
      winners.push(resolve(node));
      ids.push(node.id);
    }
    lbCur = winners.filter((w) => w !== null);
    lbPrevIds = ids.filter((id) => id !== null);
  }

  const lbChamp = lbCur[0];
  const lbFinalId = lbPrevIds[0];
  events.push({
    type: 'bracketChamp',
    bracket: 'L',
    player: lbChamp,
    record: [stats.get(lbChamp).sw, stats.get(lbChamp).sl],
  });

  // ---------------- grand final (losers-side entrant must win twice) ----------------
  addRound('GF', 'GF', 'Grand Final');
  const gfNode = addNode({
    id: 'm' + ++matchId,
    roundKey: 'GF',
    bracket: 'GF',
    round: 1,
    pos: 0,
    a: wbChamp,
    b: lbChamp,
    fromA: wbFinalId,
    fromB: lbFinalId,
  });
  let champion = series(gfNode);
  let runnerUp = gfNode.loser;

  if (champion === lbChamp) {
    events.push({ type: 'reset', by: lbChamp, over: wbChamp });
    addRound('GF2', 'GF', 'Grand Final - RESET');
    const resetNode = addNode({
      id: 'm' + ++matchId,
      roundKey: 'GF2',
      bracket: 'GF',
      round: 2,
      pos: 0,
      a: wbChamp,
      b: lbChamp,
      fromA: gfNode.id,
      fromB: null,
    });
    champion = series(resetNode);
    runnerUp = resetNode.loser;
  }

  // ---- placements, ordered by when each entrant actually went out ----
  const elimOrder = [];
  for (const e of events) if (e.type === 'match' && e.eliminated) elimOrder.push(e.eliminated);
  const placements = [champion, runnerUp].concat(elimOrder.slice().reverse().filter((n) => n !== runnerUp));

  let totalGames = 0;
  stats.forEach((s) => { totalGames += s.gw; });

  events.push({
    type: 'result',
    champion,
    runnerUp,
    placements: placements.map((n, i) => Object.assign({ place: i + 1 }, stats.get(n))),
    standings: snapshot(),
    totals: { series: events.filter((e) => e.type === 'match').length, games: totalGames },
  });

  // rounds carry their nodes, for renderers that lay out column by column
  const rounds = roundMeta.map((r) => Object.assign({}, r, {
    matches: nodes.filter((n) => n.roundKey === r.key),
  }));

  return { seed, bestOf, bracketSize, byeCount, wbRoundCount, lbRoundCount, roster, rounds, nodes, events };
}

module.exports = { simulate, DEFAULT_ROSTER, buildWeights, probOf, wilsonLower, weightsFromScores };
