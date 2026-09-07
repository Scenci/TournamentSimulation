'use strict';

/* ------------------------------------------------------------------ *
 * Tournament Sim - client playback.
 *
 * The server simulates the whole tournament up front and hands back a flat
 * event timeline. Everything here is presentation.
 *
 * The board is a bracket tree with SVG connectors between matches. Match boxes
 * follow a .match[data-id][data-round-key] contract holding .slot[data-side]
 * rows and a .pips strip, which is what the playback engine drives. Switching
 * to the Matchups tab and back replays silently up to the current beat.
 * ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);

const el = {
  play: $('#play'), step: $('#step'), skip: $('#skip'), again: $('#again'),
  speed: $('#speed'), speedVal: $('#speedVal'), bestOf: $('#bestOf'), seed: $('#seed'),
  board: $('#board'), stage: $('.stage'), phase: $('#phase'), log: $('#log'), standings: $('#standings'),
  alive: $('#aliveCount'), progress: $('#progress').firstElementChild,
  podium: $('#podium'), champName: $('#champName'), champRec: $('#champRec'),
  finalTable: $('#finalTable'), totals: $('#totals'), closePodium: $('#closePodium'),
  rosterBtn: $('#roster'), rosterModal: $('#rosterModal'), rosterText: $('#rosterText'),
  rosterSave: $('#rosterSave'), rosterCancel: $('#rosterCancel'), rosterReset: $('#rosterReset'),
  viewGraph: $('#viewGraph'), viewMatch: $('#viewMatch'),
  zoomCtl: $('#zoomCtl'), zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), zoomFit: $('#zoomFit'),
  matrix: $('#matrix'), mxTable: $('#mxTable'), mxDirty: $('#mxDirty'),
  mxReset: $('#mxReset'), mxExport: $('#mxExport'), mxImport: $('#mxImport'), mxApply: $('#mxApply'),
  mxVerify: $('#mxVerify'), mxProof: $('#mxProof'),
  steamLoad: $('#steamLoad'), steamMeta: $('#steamMeta'), steamBody: $('#steamBody'),
  steamSize: $('#steamSize'), steamSizeVal: $('#steamSizeVal'),
  steamK: $('#steamK'), steamKVal: $('#steamKVal'),
  steamClamp: $('#steamClamp'), steamClampVal: $('#steamClampVal'),
  steamApply: $('#steamApply'), steamPreview: $('#steamPreview'),
  ioModal: $('#ioModal'), ioTitle: $('#ioTitle'), ioText: $('#ioText'), ioHint: $('#ioHint'),
  ioCancel: $('#ioCancel'), ioSave: $('#ioSave'),
  simTimes: $('#simTimes'), simRun: $('#simRun'),
  batchModal: $('#batchModal'), batchTitle: $('#batchTitle'), batchMeta: $('#batchMeta'),
  batchBody: $('#batchBody'), batchClose: $('#batchClose'),
};

// timings in ms at 1x
const T = { round: 500, pre: 260, game: 420, settle: 620, elim: 260, beat: 900 };

// bracket-view geometry
// LABEL_H reserves room above each lane's first row for the lane heading and
// the per-round labels, which sit on separate lines.
const G = { BOX_W: 190, SLOT_H: 24, PIPS_H: 10, GAP_X: 56, PITCH: 74, LANE_GAP: 96, PAD: 26, LABEL_H: 42 };
G.BOX_H = G.SLOT_H * 2 + G.PIPS_H;
G.BYE_H = G.SLOT_H;
G.COL_W = G.BOX_W + G.GAP_X;

let data = null;        // current simulation
let roster = null;      // null = server default
let view = 'bracket';
let weights = Object.create(null); // W[a][b] = % chance a takes a game off b
let weightsDirty = false;
let zoom = 1;
let playing = false;
let fast = false;       // "skip to end"
let stepOnce = false;
let run = 0;            // increments to cancel an in-flight playback
let idx = 0;            // index of the next event to apply

const CANCEL = Symbol('cancel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const speed = () => 0.1 * Math.pow(250, Number(el.speed.value) / 100);

function showSpeed() {
  const s = speed();
  el.speedVal.textContent = (s < 10 ? s.toFixed(1) : Math.round(s)) + '\u00d7';
}

/** Consume `units` of virtual ms, re-reading speed/pause state as it goes. */
async function wait(units, token, instant) {
  if (instant || fast) { if (token !== run) throw CANCEL; return; }
  let left = units;
  while (left > 0) {
    if (token !== run) throw CANCEL;
    if (fast) return;
    if (!playing) {
      if (stepOnce) { stepOnce = false; return; }
      await sleep(60);
      continue;
    }
    await sleep(25);
    left -= 25 * speed();
  }
  if (token !== run) throw CANCEL;
}

/* ------------------------------ helpers ------------------------------ */

function tag(name, cls, text) {
  const n = document.createElement(name);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svgEl(name, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function cssEscape(v) {
  return window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
}

function card(id) { return el.board.querySelector('.match[data-id="' + id + '"]'); }
function roundNodes(key) { return [...el.board.querySelectorAll('.match[data-round-key="' + key + '"]')]; }

/** One competitor row. Bye nodes only get an 'a' row. */
function slot(side) {
  const s = tag('div', 'slot tbd');
  s.dataset.side = side;
  s.append(tag('span', 'sd', ''), tag('span', 'nm', 'TBD'), tag('span', 'sc', ''));
  return s;
}

function matchBox(node) {
  const box = tag('div', 'match' + (node.bye ? ' bye-node' : ''));
  box.dataset.id = node.id;
  box.dataset.roundKey = node.roundKey;
  box.dataset.a = node.a || '';
  box.dataset.b = node.b || '';
  if (node.bye) {
    box.append(slot('a'));
  } else {
    box.append(slot('a'), slot('b'));
    const pips = tag('div', 'pips');
    for (let i = 0; i < data.bestOf; i++) pips.append(tag('i', 'pip'));
    box.append(pips);
  }
  return box;
}

/* ------------------------------ renderer: bracket graph ------------------------------ */

/**
 * Lay the tournament out as a tree. Leaves of each lane sit on a fixed pitch;
 * every later match is centred on the matches that feed it, which is what
 * produces the familiar bracket shape.
 */
function layout() {
  const pos = new Map(); // node id -> {x, y, h, node}
  const byId = new Map(data.nodes.map((n) => [n.id, n]));

  const lanesOf = (b) => {
    const keys = [];
    for (const r of data.rounds) if (r.bracket === b && !keys.includes(r.key)) keys.push(r.key);
    return keys;
  };

  function placeLane(keys, topY) {
    let cursor = topY;
    keys.forEach((key, ri) => {
      const list = data.nodes.filter((n) => n.roundKey === key);
      list.forEach((n, i) => {
        const h = n.bye ? G.BYE_H : G.BOX_H;
        let centre;
        const feeders = [n.fromA, n.fromB].filter((f) => f && pos.has(f));
        if (ri === 0 || !feeders.length) {
          centre = cursor + i * G.PITCH + G.PITCH / 2;
        } else {
          let sum = 0;
          for (const f of feeders) sum += pos.get(f).y + pos.get(f).h / 2;
          centre = sum / feeders.length;
        }
        pos.set(n.id, { x: G.PAD + ri * G.COL_W, y: centre - h / 2, h, node: n });
      });
      if (ri === 0) cursor += list.length * G.PITCH;
    });
    return cursor;
  }

  const wKeys = lanesOf('W');
  const lKeys = lanesOf('L');
  const gKeys = lanesOf('GF');

  const wBottom = placeLane(wKeys, G.PAD + G.LABEL_H);
  const lTop = wBottom + G.LANE_GAP + G.LABEL_H;
  const lBottom = placeLane(lKeys, lTop);

  // grand final sits between the two lanes, past the widest one
  const gfCol = Math.max(wKeys.length, lKeys.length);
  gKeys.forEach((key, i) => {
    const list = data.nodes.filter((n) => n.roundKey === key);
    list.forEach((n) => {
      const feeders = [n.fromA, n.fromB].filter((f) => f && pos.has(f));
      let sum = 0;
      for (const f of feeders) sum += pos.get(f).y + pos.get(f).h / 2;
      const centre = feeders.length ? sum / feeders.length : (G.PAD + lBottom) / 2;
      pos.set(n.id, { x: G.PAD + (gfCol + i) * G.COL_W, y: centre - G.BOX_H / 2, h: G.BOX_H, node: n });
    });
  });

  let maxX = 0;
  let maxY = 0;
  pos.forEach((p) => {
    maxX = Math.max(maxX, p.x + G.BOX_W);
    maxY = Math.max(maxY, p.y + p.h);
  });

  return { pos, byId, wKeys, lKeys, gKeys, gfCol, wBottom, lTop, width: maxX + G.PAD, height: maxY + G.PAD };
}

/** Left-edge anchor for a competitor row, so edges land on the right name. */
function slotY(p, side) {
  if (p.node.bye) return p.y + G.BYE_H / 2;
  return p.y + (side === 'b' ? G.SLOT_H * 1.5 : G.SLOT_H * 0.5);
}

function elbow(x1, y1, x2, y2) {
  const mid = x1 + Math.max(18, (x2 - x1) / 2);
  return 'M' + x1 + ' ' + y1 + ' H' + mid + ' V' + y2 + ' H' + x2;
}

function renderGraph() {
  const L = layout();
  el.board.className = 'board graph';
  el.board.textContent = '';
  el.board.style.width = L.width + 'px';
  el.board.style.height = L.height + 'px';

  const svg = svgEl('svg', { class: 'edges', width: L.width, height: L.height, viewBox: '0 0 ' + L.width + ' ' + L.height });
  el.board.append(svg);

  // lane headings
  const wTop = G.PAD + G.LABEL_H;
  const heads = [
    { y: wTop - G.LABEL_H, text: 'Winners Bracket', cls: 'w' },
    { y: L.lTop - G.LABEL_H, text: 'Losers Bracket \u2014 one more loss and you are out', cls: 'l' },
  ];
  for (const h of heads) {
    const n = tag('div', 'glane glane-' + h.cls, h.text);
    n.style.top = h.y + 'px';
    n.style.left = G.PAD + 'px';
    el.board.append(n);
  }

  // round labels
  const label = (key, name, col, y) => {
    const n = tag('div', 'glabel', name);
    n.dataset.key = key;
    n.style.left = G.PAD + col * G.COL_W + 'px';
    n.style.top = y + 'px';
    n.style.width = G.BOX_W + 'px';
    el.board.append(n);
  };
  L.wKeys.forEach((k, i) => label(k, roundName(k), i, wTop - 18));
  L.lKeys.forEach((k, i) => label(k, roundName(k), i, L.lTop - 18));
  L.gKeys.forEach((k, i) => {
    const p = L.pos.get(data.nodes.find((n) => n.roundKey === k).id);
    label(k, roundName(k), L.gfCol + i, p.y - 20);
  });

  // edges first, so boxes paint over them
  for (const n of data.nodes) {
    const p = L.pos.get(n.id);
    if (!p) continue;
    const draw = (fromId, side, cls) => {
      const f = L.pos.get(fromId);
      if (!f) return;
      const path = svgEl('path', {
        d: elbow(f.x + G.BOX_W, edgeExitY(f), p.x, slotY(p, side)),
        class: 'edge ' + cls,
      });
      path.dataset.to = n.id;
      path.dataset.from = fromId;
      svg.append(path);
    };
    if (n.fromA) draw(n.fromA, 'a', 'e-adv');
    if (n.fromB) draw(n.fromB, 'b', 'e-adv');
    if (n.dropFrom) draw(n.dropFrom, 'b', 'e-drop');
  }

  // boxes
  for (const n of data.nodes) {
    const p = L.pos.get(n.id);
    if (!p) continue;
    const box = matchBox(n);
    box.style.left = p.x + 'px';
    box.style.top = p.y + 'px';
    box.style.width = G.BOX_W + 'px';
    el.board.append(box);
  }

  applyZoom();
}

/** Edges leave a box from the winner's row once it is decided, centre before. */
function edgeExitY(p) {
  return p.node.bye ? p.y + G.BYE_H / 2 : p.y + G.BOX_H / 2;
}

function roundName(key) {
  const r = data.rounds.find((x) => x.key === key);
  return r ? r.name : key;
}

function applyZoom() {
  if (view !== 'graph') return;
  el.board.style.transform = 'scale(' + zoom + ')';
  el.board.style.transformOrigin = '0 0';
  const w = parseFloat(el.board.style.width) || 0;
  const h = parseFloat(el.board.style.height) || 0;
  el.stage.style.setProperty('--gw', w * zoom + 'px');
  el.stage.style.setProperty('--gh', h * zoom + 34 + 'px'); // + the sticky phase strip
}

function fitZoom() {
  const w = parseFloat(el.board.style.width) || 1;
  const avail = el.stage.clientWidth - 40;
  zoom = Math.max(0.3, Math.min(1, avail / w));
  applyZoom();
}

/* ------------------------------ Steam Pro Tour ------------------------------ */

/**
 * Build a field and a matchup chart from the committed Steam snapshot.
 *
 * Scoring mirrors sim.js exactly (Wilson lower bound -> logit difference), but is
 * duplicated here rather than imported because the client is plain script tags
 * with no module loader. The server is the authority; this is for the preview and
 * for filling the editable matrix.
 */
let steamData = null;

const wilsonLower = (pos, total, z) => {
  const n = Number(total) || 0;
  if (n <= 0) return 0;
  const zz = z === undefined ? 1.96 : z;
  const p = Math.max(0, Math.min(n, Number(pos) || 0)) / n;
  const z2 = zz * zz;
  return (p + z2 / (2 * n) - zz * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
};
const lg = (x) => Math.log(x / (1 - x));
const sg = (x) => 1 / (1 + Math.exp(-x));

/** Odds that a per-game probability survives a best-of-N series. */
function seriesOdds(p, bestOf) {
  const need = Math.ceil(bestOf / 2);
  const C = (n, r) => { let v = 1; for (let i = 0; i < r; i++) v = (v * (n - i)) / (i + 1); return v; };
  let s = 0;
  for (let l = 0; l < need; l++) s += C(need - 1 + l, l) * Math.pow(p, need) * Math.pow(1 - p, l);
  return s;
}

const steamK = () => Number(el.steamK.value) / 100;
const steamClamp = () => Number(el.steamClamp.value) / 100;

/** Top-N snapshot games by Wilson score, with their derived rating. */
function steamField() {
  if (!steamData) return [];
  return steamData.games
    .map((g) => ({ name: g.name, score: wilsonLower(g.positive, g.total), total: g.total, raw: g.positive / g.total }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(el.steamSize.value));
}

function steamPairs(field) {
  const k = steamK();
  const lo = steamClamp();
  const hi = 1 - lo;
  const out = [];
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const p = Math.max(lo, Math.min(hi, sg(k * (lg(field[i].score) - lg(field[j].score)))));
      out.push([field[i].name, field[j].name, Math.round(p * 100)]);
    }
  }
  return out;
}

function renderSteamPreview() {
  el.steamSizeVal.textContent = el.steamSize.value;
  el.steamKVal.textContent = steamK().toFixed(2);
  el.steamClampVal.textContent = el.steamClamp.value + '%';
  if (!steamData) return;

  const field = steamField();
  el.steamPreview.textContent = '';
  if (field.length < 4) {
    el.steamPreview.append(tag('div', 'mx-note', 'Need at least 4 games.'));
    return;
  }

  const pairs = steamPairs(field);
  let widest = pairs[0];
  for (const p of pairs) if (Math.abs(p[2] - 50) > Math.abs(widest[2] - 50)) widest = p;
  const bo = Number(el.bestOf.value);
  const favPct = Math.max(widest[2], 100 - widest[2]) / 100;
  const fav = widest[2] >= 50 ? widest[0] : widest[1];
  const dog = widest[2] >= 50 ? widest[1] : widest[0];

  const top = field[0];
  const bot = field[field.length - 1];

  const line = (label, node) => {
    const d = tag('div', 'sp-line');
    d.append(tag('span', 'sp-k', label), node);
    el.steamPreview.append(d);
  };

  line('Field', tag('span', null,
    field.length + ' games · best ' + top.name + ' (' + (top.score * 100).toFixed(1) + '%)'
    + ' · worst ' + bot.name + ' (' + (bot.score * 100).toFixed(1) + '%)'));

  const w = tag('span', null);
  w.append(tag('b', 'sp-fav', fav), document.createTextNode(' beats ' + dog + ' '));
  w.append(tag('b', null, Math.round(favPct * 100) + '%'), document.createTextNode(' per game → '));
  w.append(tag('b', null, Math.round(seriesOdds(favPct, bo) * 100) + '%'), document.createTextNode(' over a Bo' + bo));
  line('Widest', w);

  const evens = pairs.filter((p) => p[2] === 50).length;
  line('Spread', tag('span', 'mx-note',
    pairs.length + ' pairings · ' + evens + ' dead even · '
    + (Math.abs(widest[2] - 50) > 24 ? 'capped — lower Competitiveness or raise Cap for closer games'
      : 'a favourite still loses often enough to be interesting')));
}

async function loadSteam() {
  el.steamLoad.disabled = true;
  el.steamMeta.textContent = 'Loading…';
  try {
    const res = await fetch('/api/steam');
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    steamData = json;
    const when = new Date(json.fetchedAt);
    el.steamMeta.textContent = json.games.length + ' games · snapshot '
      + (isNaN(when) ? json.fetchedAt : when.toISOString().slice(0, 10));
    el.steamSize.max = String(Math.min(24, json.games.length));
    if (Number(el.steamSize.value) > json.games.length) el.steamSize.value = String(json.games.length);
    el.steamBody.hidden = false;
    renderSteamPreview();
  } catch (err) {
    el.steamMeta.textContent = err.message;
  } finally {
    el.steamLoad.disabled = false;
  }
}

el.steamLoad.addEventListener('click', loadSteam);
for (const c of [el.steamSize, el.steamK, el.steamClamp]) c.addEventListener('input', renderSteamPreview);

el.steamApply.addEventListener('click', () => {
  const field = steamField();
  if (field.length < 4) return;

  roster = field.map((f) => f.name);
  weights = Object.create(null);
  for (const [a, b, pct] of steamPairs(field)) setWeight(a, b, pct);

  saveWeights();
  renderMatrix();
  markDirty(true);
  el.mxProof.hidden = true;
  say('Steam field loaded: ' + field.length + ' games, weights from Wilson-adjusted review scores.', 'big');
});

/* ------------------------------ matchup weights ------------------------------ */

const WKEY = 'tsim.weights.v1';

/** Set one pairing and its mirror together, so the two can never disagree. */
function setWeight(a, b, pct) {
  const v = Math.max(0, Math.min(100, Math.round(Number(pct))));
  if (!Number.isFinite(v) || a === b) return 50;
  (weights[a] || (weights[a] = Object.create(null)))[b] = v;
  (weights[b] || (weights[b] = Object.create(null)))[a] = 100 - v;
  return v;
}

function getWeight(a, b) {
  const row = weights[a];
  const v = row && row[b];
  return v === undefined ? 50 : v;
}

/** Serialize as canonical [a, b, pct] triples, one per pairing, a < b. */
function weightTriples() {
  const out = [];
  for (const a of Object.keys(weights)) {
    for (const b of Object.keys(weights[a])) {
      if (a < b && weights[a][b] !== 50) out.push([a, b, weights[a][b]]);
    }
  }
  return out;
}

function loadWeights() {
  try {
    const raw = localStorage.getItem(WKEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const row of list) if (Array.isArray(row) && row.length >= 3) setWeight(row[0], row[1], row[2]);
  } catch (err) {
    /* private window, cleared storage, blocked site data - just start even */
  }
}

function saveWeights() {
  try {
    localStorage.setItem(WKEY, JSON.stringify(weightTriples()));
  } catch (err) { /* non-fatal: weights still apply for this session */ }
}

function entrantList() {
  return roster || (data && data.roster) || [];
}

function oddsColor(pct) {
  if (pct === 50) return '';
  const t = Math.min(1, Math.abs(pct - 50) / 50);
  const hue = pct > 50 ? 145 : 353;
  return 'background:hsla(' + hue + ',70%,45%,' + (0.10 + t * 0.42).toFixed(3) + ')';
}

function markDirty(on) {
  weightsDirty = on;
  el.mxDirty.hidden = !on;
  el.viewMatch.classList.toggle('dot', on);
}

function renderMatrix() {
  const names = entrantList();
  el.mxTable.textContent = '';

  const thead = tag('thead');
  const hr = tag('tr');
  hr.append(tag('th', 'corner', 'row beats column →'));
  names.forEach((n, i) => {
    const th = tag('th', 'colh', String(i + 1));
    th.title = n;
    hr.append(th);
  });
  hr.append(tag('th', 'colh avg', 'avg'));
  thead.append(hr);
  el.mxTable.append(thead);

  const tb = tag('tbody');
  names.forEach((a, i) => {
    const tr = tag('tr');
    const rh = tag('th', 'rowh');
    rh.append(tag('span', 'ix', String(i + 1)), tag('span', 'nm', a));
    rh.title = a;
    tr.append(rh);

    names.forEach((b, j) => {
      if (i === j) { tr.append(tag('td', 'diag', '—')); return; }
      const td = tag('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '100';
      inp.step = '1';
      inp.value = String(getWeight(a, b));
      inp.dataset.a = a;
      inp.dataset.b = b;
      inp.setAttribute('aria-label', a + ' beats ' + b);
      inp.title = a + ' beats ' + b;
      td.append(inp);
      tr.append(td);
    });

    tr.append(tag('td', 'avg', avgFor(a, names)));
    tb.append(tr);
  });
  el.mxTable.append(tb);
  paintMatrix();
}

function avgFor(a, names) {
  const others = names.filter((n) => n !== a);
  if (!others.length) return '—';
  let sum = 0;
  for (const b of others) sum += getWeight(a, b);
  return (sum / others.length).toFixed(1) + '%';
}

/** Repaint every cell from the model - cheap enough at these sizes. */
function paintMatrix() {
  const names = entrantList();
  for (const inp of el.mxTable.querySelectorAll('input')) {
    const v = getWeight(inp.dataset.a, inp.dataset.b);
    if (document.activeElement !== inp) inp.value = String(v);
    inp.parentElement.style.cssText = oddsColor(v);
    inp.classList.toggle('even', v === 50);
  }
  const rows = el.mxTable.querySelectorAll('tbody tr');
  names.forEach((a, i) => {
    const cell = rows[i] && rows[i].querySelector('td.avg');
    if (cell) cell.textContent = avgFor(a, names);
  });
}

el.mxTable.addEventListener('input', (e) => {
  const inp = e.target;
  if (!inp.matches('input')) return;
  setWeight(inp.dataset.a, inp.dataset.b, inp.value === '' ? 50 : inp.value);
  saveWeights();
  paintMatrix();
  markDirty(true);
});

el.mxTable.addEventListener('change', (e) => {
  if (e.target.matches('input')) paintMatrix(); // normalize what was typed
});

el.mxReset.addEventListener('click', () => {
  weights = Object.create(null);
  saveWeights();
  renderMatrix();
  markDirty(true);
});

// Applying returns to whichever board view you came from - you asked for a
// redraw, so you should be looking at it.
el.mxApply.addEventListener('click', () => {
  markDirty(false);
  view = 'bracket';
  applyViewChrome(view);
  load();
});

/**
 * Proof the weights are live: re-run this exact configuration many times and
 * compare the rate actually observed across every game played to the rate set
 * in the chart. Lives here rather than on the bracket so the normal view stays
 * uncluttered.
 */
el.mxVerify.addEventListener('click', async () => {
  const triples = weightTriples();
  el.mxProof.hidden = false;
  el.mxProof.textContent = '';

  if (!triples.length) {
    el.mxProof.append(tag('div', 'proof-msg', 'Nothing to verify — every pairing is still an even 50/50.'));
    return;
  }

  el.mxVerify.disabled = true;
  el.mxProof.append(tag('div', 'proof-msg', 'Running 2,000 tournaments…'));

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bestOf: Number(el.bestOf.value), roster: roster || undefined, weights: triples, runs: 2000 }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    renderProof(out);
  } catch (err) {
    el.mxProof.textContent = '';
    el.mxProof.append(tag('div', 'proof-msg', 'Verify failed: ' + err.message));
  } finally {
    el.mxVerify.disabled = false;
  }
});

function renderProof(out) {
  el.mxProof.textContent = '';

  const head = tag('div', 'proof-head');
  head.append(tag('b', null, 'Weights verified live.'));
  head.append(tag('span', null,
    ' ' + out.runs.toLocaleString() + ' tournaments simulated in ' + out.ms + 'ms. '
    + 'Observed is the share of actual games won, across every time the pairing met.'));
  el.mxProof.append(head);

  const t = tag('table', 'proof');
  const th = tag('tr');
  ['Pairing', 'Set', 'Observed', 'Δ', 'Games', 'Meetings'].forEach((h) => th.append(tag('th', null, h)));
  t.append(th);

  let worst = 0;
  for (const p of out.pairs) {
    const tr = tag('tr');
    tr.append(tag('td', 'pair', p.a + ' vs ' + p.b));
    tr.append(tag('td', 'num', p.setPct + '%'));

    if (p.observedPct === null) {
      tr.append(tag('td', 'num none', '—'), tag('td', 'num none', '—'));
    } else {
      const d = p.observedPct - p.setPct;
      worst = Math.max(worst, Math.abs(d));
      tr.append(tag('td', 'num', p.observedPct.toFixed(1) + '%'));
      const dc = tag('td', 'num ' + (Math.abs(d) <= 2 ? 'ok' : 'off'), (d >= 0 ? '+' : '') + d.toFixed(1));
      tr.append(dc);
    }
    tr.append(tag('td', 'num dim', p.games.toLocaleString()));
    tr.append(tag('td', 'num dim', p.series.toLocaleString()));
    t.append(tr);
  }
  el.mxProof.append(t);

  const met = out.pairs.filter((p) => p.games > 0).length;
  el.mxProof.append(tag('div', 'proof-msg',
    met === out.pairs.length
      ? 'Every weighted pairing met at least once. Largest gap from the set value: ' + worst.toFixed(1) + ' points.'
      : (out.pairs.length - met) + ' pairing(s) never met — the bracket kept them apart. Largest gap elsewhere: ' + worst.toFixed(1) + ' points.'));
}

function openIO(mode) {
  const importing = mode === 'import';
  el.ioTitle.textContent = importing ? 'Import matchup weights' : 'Export matchup weights';
  el.ioText.value = importing ? '' : JSON.stringify(weightTriples(), null, 2);
  el.ioText.readOnly = !importing;
  el.ioSave.hidden = !importing;
  el.ioHint.textContent = importing
    ? 'Paste an array of [winner, loser, percent] triples.'
    : weightTriples().length + ' pairing(s) differ from 50/50.';
  el.ioModal.classList.remove('hidden');
  el.ioText.focus();
  if (!importing) el.ioText.select();
}

el.mxExport.addEventListener('click', () => openIO('export'));
el.mxImport.addEventListener('click', () => openIO('import'));
el.ioCancel.addEventListener('click', () => el.ioModal.classList.add('hidden'));

el.ioSave.addEventListener('click', () => {
  let list;
  try {
    list = JSON.parse(el.ioText.value);
  } catch (err) {
    el.ioHint.textContent = 'Could not parse that as JSON.';
    return;
  }
  if (!Array.isArray(list)) { el.ioHint.textContent = 'Expected a JSON array.'; return; }
  let n = 0;
  for (const row of list) {
    if (Array.isArray(row) && row.length >= 3 && setWeight(row[0], row[1], row[2]) !== undefined) n++;
  }
  saveWeights();
  renderMatrix();
  markDirty(true);
  el.ioModal.classList.add('hidden');
  say('Imported ' + n + ' matchup weight(s).', 'hl');
});

/* ------------------------------ shared UI bits ------------------------------ */

function drawStandings(list) {
  el.standings.textContent = '';
  for (const s of list.slice().sort((a, b) => a.seed - b.seed)) {
    const li = tag('li');
    li.dataset.name = s.name;
    li.append(tag('span', 'sd', '#' + s.seed), tag('span', 'nm', s.name), tag('span', 'rc', (s.sw || 0) + '-' + (s.sl || 0)));
    el.standings.append(li);
  }
  el.alive.textContent = list.length + ' alive';
}

function syncStandings(list) {
  let alive = 0;
  for (const s of list) {
    const li = el.standings.querySelector('[data-name="' + cssEscape(s.name) + '"]');
    if (!li) continue;
    li.querySelector('.rc').textContent = s.sw + '-' + s.sl;
    li.classList.toggle('out', s.out);
    if (!s.out) alive++;
  }
  el.alive.textContent = alive + ' alive';
}

function flash(names, on) {
  for (const n of names) {
    const li = el.standings.querySelector('[data-name="' + cssEscape(n) + '"]');
    if (li) li.classList.toggle('hit', on);
  }
}

function say(text, cls) {
  const p = tag('p', cls || null, text);
  el.log.append(p);
  el.log.scrollTop = el.log.scrollHeight;
  while (el.log.children.length > 300) el.log.firstChild.remove();
}

function fill(box, side, name, seed, animate) {
  const s = box.querySelector('.slot[data-side="' + side + '"]');
  if (!s || !name) return null;
  s.classList.remove('tbd');
  s.querySelector('.sd').textContent = '#' + seed;
  s.querySelector('.nm').textContent = name;
  s.querySelector('.sc').textContent = box.classList.contains('bye-node') ? '' : '0';
  if (animate) {
    s.classList.remove('enter');
    void s.offsetWidth;
    s.classList.add('enter');
  }
  return s;
}

function scrollTo(node, instant) {
  if (!node || instant) return;
  const box = node.getBoundingClientRect();
  const port = el.stage.getBoundingClientRect();
  if (box.bottom > port.bottom - 20 || box.top < port.top + 40 || box.right > port.right - 20 || box.left < port.left + 10) {
    node.scrollIntoView({ behavior: fast ? 'auto' : 'smooth', block: 'center', inline: 'center' });
  }
}

function highlightEdges(id, on) {
  for (const p of el.board.querySelectorAll('path.edge[data-to="' + id + '"], path.edge[data-from="' + id + '"]')) {
    p.classList.toggle('lit', on);
  }
}

/* ------------------------------ playback ------------------------------ */

const seedMap = new Map();

async function applyEvent(ev, token, instant) {
  switch (ev.type) {
    case 'seeding': {
      seedMap.clear();
      for (const f of ev.field) seedMap.set(f.name, f.seed);
      drawStandings(ev.field.map((f) => ({ name: f.name, seed: f.seed, sw: 0, sl: 0, out: false })));
      say('Draw: ' + ev.field.length + ' entrants, ' + ev.bracketSize + '-slot bracket, best of ' + ev.bestOf + '.', 'big');
      if (ev.byeCount) say(ev.byeCount + ' bye' + (ev.byeCount > 1 ? 's' : '') + ' to fill a ' + ev.bracketSize + '-slot draw.', 'hl');
      const nw = weightTriples().length;
      say(nw
        ? 'Matchup weights ACTIVE on ' + nw + ' pairing' + (nw > 1 ? 's' : '') + ' — weighted games are flagged below.'
        : 'No matchup weights — every game is an even coin flip.', nw ? 'big' : null);
      await wait(T.round, token, instant);
      break;
    }

    case 'round': {
      const boxes = roundNodes(ev.key);
      for (const b of boxes) {
        fill(b, 'a', b.dataset.a, seedMap.get(b.dataset.a), !instant);
        fill(b, 'b', b.dataset.b, seedMap.get(b.dataset.b), !instant);
      }
      for (const g of el.board.querySelectorAll('.glabel.active')) g.classList.remove('active');
      const lab = el.board.querySelector('.glabel[data-key="' + ev.key + '"]');
      if (lab) lab.classList.add('active');
      if (boxes[0]) scrollTo(boxes[0], instant);

      el.phase.textContent = '';
      el.phase.append(tag('b', null, ev.name));
      say('\u2014 ' + ev.name + ' \u2014', 'hl');
      await wait(T.round, token, instant);
      break;
    }

    case 'bye': {
      const b = card(ev.id);
      if (b) {
        fill(b, 'a', ev.player, ev.seed, !instant);
        b.classList.add('settled');
        const s = b.querySelector('.slot[data-side="a"]');
        s.classList.add('win');
        if (!s.querySelector('.badge')) s.append(tag('span', 'badge by', 'bye'));
      }
      break;
    }

    case 'drop': {
      say('Dropping down: ' + ev.players.join(', '), 'hl');
      break;
    }

    case 'match': {
      const c = card(ev.id);
      if (!c) break;
      const aSlot = c.querySelector('.slot[data-side="a"]');
      const bSlot = c.querySelector('.slot[data-side="b"]');
      const pips = [...c.querySelectorAll('.pip')];

      // show the pairing's weight when it isn't an even coin flip
      if (ev.odds !== undefined && ev.odds !== 50 && !c.querySelector('.odds')) {
        const strip = c.querySelector('.pips');
        if (strip) strip.append(tag('span', 'odds', ev.odds + '/' + (100 - ev.odds)));
      }

      if (!instant) {
        c.classList.add('live');
        highlightEdges(ev.id, true);
        scrollTo(c, instant);
        flash([ev.a, ev.b], true);
        await wait(T.pre, token, instant);
      }

      // tick the series out game by game
      let sa = 0;
      let sb = 0;
      for (let i = 0; i < ev.games.length; i++) {
        const aWon = ev.games[i] === ev.a;
        if (aWon) sa++; else sb++;
        if (pips[i]) pips[i].classList.add(aWon ? 'a' : 'b');
        aSlot.querySelector('.sc').textContent = String(sa);
        bSlot.querySelector('.sc').textContent = String(sb);
        if (!instant) {
          const hit = aWon ? aSlot : bSlot;
          hit.classList.remove('point');
          void hit.offsetWidth;
          hit.classList.add('point');
          await wait(T.game, token, instant);
        }
      }

      c.classList.remove('live');
      c.classList.add('settled');
      highlightEdges(ev.id, false);
      const winSlot = ev.winner === ev.a ? aSlot : bSlot;
      const loseSlot = ev.winner === ev.a ? bSlot : aSlot;
      winSlot.classList.add('win');
      loseSlot.classList.add('lose');

      if (ev.sweep && !winSlot.querySelector('.badge.sw')) winSlot.append(tag('span', 'badge sw', 'sweep'));
      if (ev.upset && !winSlot.querySelector('.badge.up')) winSlot.append(tag('span', 'badge up', 'upset'));

      // Every weighted match is annotated with the winner's per-game odds, so the
      // weighting is visible in the run itself rather than only in the chart.
      const wOdds = ev.odds === undefined ? 50 : (ev.winner === ev.a ? ev.odds : 100 - ev.odds);
      let note = ev.upset ? '  (upset)' : '';
      if (wOdds !== 50) note += '  · ' + wOdds + '% ' + (wOdds < 50 ? 'underdog' : 'favourite');
      say(ev.winner + ' def. ' + ev.loser + ' ' + ev.score[0] + '-' + ev.score[1] + note,
        (ev.upset || wOdds < 50) ? 'up' : (wOdds !== 50 ? 'wt' : null));

      syncStandings(ev.standings);
      flash([ev.a, ev.b], false);

      // Losing the grand final is technically a second loss, but calling the
      // runner-up "eliminated" reads wrong - the podium announces them instead.
      if (ev.eliminated && ev.roundKey.indexOf('GF') !== 0) {
        loseSlot.classList.add('dead');
        if (!loseSlot.querySelector('.badge.out')) loseSlot.append(tag('span', 'badge out', 'out'));
        const rec = ev.standings.find((s) => s.name === ev.eliminated);
        say(ev.eliminated + ' is ELIMINATED (' + rec.sw + '-' + rec.sl + ' series, ' + rec.gw + '-' + rec.gl + ' games)', 'elim');
        await wait(T.elim, token, instant);
      }
      await wait(T.settle, token, instant);
      break;
    }

    case 'bracketChamp': {
      const where = ev.bracket === 'W' ? 'Winners bracket' : 'Losers bracket';
      say(where + ' champion: ' + ev.player + ' (' + ev.record[0] + '-' + ev.record[1] + ')', 'big');
      await wait(T.beat, token, instant);
      break;
    }

    case 'reset': {
      el.phase.textContent = '';
      el.phase.append(tag('b', null, 'BRACKET RESET'));
      say('BRACKET RESET! ' + ev.by + ' hands ' + ev.over + ' its first loss. One series decides it.', 'big');
      await wait(T.beat, token, instant);
      break;
    }

    case 'result': {
      finish(ev, instant);
      break;
    }
  }
}

async function playback(token) {
  for (; idx < data.events.length; idx++) {
    if (token !== run) return;
    el.progress.style.width = (((idx + 1) / data.events.length) * 100).toFixed(1) + '%';
    await applyEvent(data.events[idx], token, false);
  }
}

/**
 * Redraw in the other view and silently catch up to where playback is.
 *
 * `idx` is the event being applied right now, not the count of finished ones,
 * so the replay has to include it - otherwise its DOM changes and log lines are
 * lost. That means cancelling the in-flight loop (which is parked inside that
 * event's wait) and restarting from the one after, so nothing runs twice.
 */
async function rebuild() {
  const resume = playing;
  const upTo = Math.min(idx, data.events.length - 1);
  run++;
  const token = run;
  playing = false;

  renderGraph();
  el.log.textContent = ''; // the silent replay re-emits every line

  for (let i = 0; i <= upTo; i++) {
    if (token !== run) return;
    await applyEvent(data.events[i], token, true);
  }

  idx = upTo + 1;
  fitZoom();
  playing = resume;
  playback(token).catch((e) => { if (e !== CANCEL) throw e; });
}

function finish(ev, instant) {
  playing = false;
  fast = false;
  el.play.textContent = '\u25b6 Play';
  el.play.disabled = true;
  el.step.disabled = true;
  el.skip.disabled = true;
  el.progress.style.width = '100%';

  el.phase.textContent = '';
  el.phase.append(tag('b', null, 'Champion: ' + ev.champion));

  const li = el.standings.querySelector('[data-name="' + cssEscape(ev.champion) + '"]');
  if (li) li.classList.add('champ');

  const box = [...el.board.querySelectorAll('.match')].pop();
  if (box) box.classList.add('crowned');

  say('CHAMPION: ' + ev.champion, 'big');

  const c = ev.placements[0];
  el.champName.textContent = ev.champion;
  el.champRec.textContent = c.sw + '-' + c.sl + ' in series \u00b7 ' + c.gw + '-' + c.gl + ' in games \u00b7 seeded #' + c.seed;

  el.finalTable.textContent = '';
  for (const p of ev.placements) {
    const row = tag('li');
    row.append(tag('span', 'pl', p.place + '.'), tag('span', 'nm', p.name), tag('span', 'rc', p.sw + '-' + p.sl + '  \u00b7  #' + p.seed));
    el.finalTable.append(row);
  }
  const weighted = data.events.filter((e) => e.type === 'match' && e.odds !== undefined && e.odds !== 50).length;
  el.totals.textContent = ev.totals.series + ' series \u00b7 ' + ev.totals.games + ' games \u00b7 seed ' + data.seed
    + (weighted ? ' \u00b7 ' + weighted + ' weighted matchup' + (weighted > 1 ? 's' : '') + ' applied' : '');
  if (!instant) el.podium.classList.remove('hidden');
}

/* ------------------------------ batch simulation ------------------------------ */

/**
 * Run the current configuration N times server-side and show the distribution.
 *
 * One bracket is a single sample of a very noisy process — a 97%-rated game can
 * and does go out in the first round. This is what separates "who won that one"
 * from "who wins".
 */
async function runBatch() {
  const runs = Math.max(2, Math.min(50000, Math.round(Number(el.simTimes.value) || 100)));
  el.simTimes.value = String(runs);

  el.batchModal.classList.remove('hidden');
  el.batchTitle.textContent = 'Simulating ' + runs.toLocaleString() + ' tournaments…';
  el.batchMeta.textContent = '';
  el.batchBody.textContent = '';
  el.simRun.disabled = true;

  try {
    const res = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runs,
        bestOf: Number(el.bestOf.value),
        roster: roster || undefined,
        weights: weightTriples(),
      }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    renderBatch(out);
  } catch (err) {
    el.batchTitle.textContent = 'Batch failed';
    el.batchBody.textContent = '';
    el.batchBody.append(tag('div', 'mx-note', err.message));
  } finally {
    el.simRun.disabled = false;
  }
}

function renderBatch(out) {
  const nw = weightTriples().length;
  el.batchTitle.textContent = out.runs.toLocaleString() + ' tournaments · ' + out.entrants + ' entrants';
  el.batchMeta.textContent =
    'Best of ' + el.bestOf.value + ' · '
    + (nw ? nw + ' weighted pairing' + (nw > 1 ? 's' : '') : 'no weights — even coin flips') + ' · '
    + out.avgSeries.toFixed(1) + ' series and ' + out.avgGames.toFixed(1) + ' games per run · '
    + ((out.resets / out.runs) * 100).toFixed(1) + '% ended in a bracket reset · '
    + out.ms + 'ms';

  el.batchBody.textContent = '';
  const t = tag('table', 'batch');
  const hr = tag('tr');
  for (const h of ['', 'Entrant', 'Titles', 'Title %', 'Finals %', 'Avg place', 'Best', 'Series W%']) {
    hr.append(tag('th', null, h));
  }
  t.append(hr);

  const most = out.rows.length ? out.rows[0].titlePct : 0;
  out.rows.forEach((r, i) => {
    const tr = tag('tr');
    tr.append(tag('td', 'rank', String(i + 1)));
    tr.append(tag('td', 'nm', r.name));
    tr.append(tag('td', 'num', r.titles.toLocaleString()));

    // a bar makes the shape of the distribution readable at a glance
    const share = tag('td', 'num share');
    const bar = tag('span', 'bar');
    bar.style.width = (most ? (r.titlePct / most) * 100 : 0).toFixed(1) + '%';
    share.append(bar, tag('span', 'pct', r.titlePct.toFixed(1) + '%'));
    tr.append(share);

    tr.append(tag('td', 'num', r.finalPct.toFixed(1) + '%'));
    tr.append(tag('td', 'num', r.avgPlace.toFixed(2)));
    tr.append(tag('td', 'num dim', r.best === null ? '—' : String(r.best)));
    tr.append(tag('td', 'num dim', r.winRate.toFixed(1) + '%'));
    t.append(tr);
  });
  el.batchBody.append(t);

  const never = out.rows.filter((r) => r.titles === 0);
  el.batchBody.append(tag('div', 'mx-note batch-foot',
    never.length
      ? never.length + ' entrant' + (never.length > 1 ? 's' : '') + ' never won: ' + never.map((r) => r.name).join(', ')
      : 'Every entrant won at least once — nothing here is a foregone conclusion.'));
}

el.simRun.addEventListener('click', runBatch);
el.batchClose.addEventListener('click', () => el.batchModal.classList.add('hidden'));
el.simTimes.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBatch(); });

/* ------------------------------ control ------------------------------ */

async function load(opts) {
  opts = opts || {};
  run++;
  playing = false;
  fast = false;
  stepOnce = false;
  idx = 0;

  const s = el.seed.value.trim();
  const body = {
    bestOf: Number(el.bestOf.value),
    seed: opts.keepSeed && s ? s : undefined,
    roster: roster || undefined,
    weights: weightTriples(),
  };

  el.log.textContent = '';
  el.board.textContent = '';
  el.standings.textContent = '';
  el.progress.style.width = '0%';
  el.phase.textContent = 'Drawing bracket\u2026';
  el.podium.classList.add('hidden');

  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) { el.phase.textContent = 'Error: ' + json.error; return; }

  data = json;
  el.seed.value = String(data.seed);
  el.bestOf.value = String(data.bestOf);

  renderGraph();
  fitZoom();

  el.phase.textContent = 'Ready \u2014 press Play';
  el.play.disabled = false;
  el.step.disabled = false;
  el.skip.disabled = false;

  const token = run;
  playback(token).catch((e) => { if (e !== CANCEL) throw e; });
}

function setPlaying(on) {
  playing = on;
  el.play.textContent = on ? '\u23f8 Pause' : '\u25b6 Play';
}

/** Toggle the chrome for a view without touching playback state. */
function applyViewChrome(v) {
  const onMatchups = v === 'matchups';
  el.viewGraph.classList.toggle('on', !onMatchups);
  el.viewMatch.classList.toggle('on', onMatchups);
  el.zoomCtl.hidden = onMatchups;
  el.stage.classList.toggle('graph-mode', !onMatchups);
  el.matrix.hidden = !onMatchups;
  el.board.hidden = onMatchups;
  el.phase.hidden = onMatchups;
}

function setView(v) {
  if (v === view) return;
  const leavingMatchups = view === 'matchups';
  view = v;
  applyViewChrome(v);

  if (v === 'matchups') {
    setPlaying(false); // editing weights while a run animates would be confusing
    renderMatrix();
    return;
  }

  if (!data) return;
  // Weights only take effect on a fresh simulation, so redraw rather than leave
  // a bracket on screen that was played under the old numbers.
  if (leavingMatchups && weightsDirty) { markDirty(false); load(); return; }
  rebuild();
}

el.play.addEventListener('click', () => setPlaying(!playing));
el.step.addEventListener('click', () => { setPlaying(false); stepOnce = true; });
el.skip.addEventListener('click', () => { fast = true; setPlaying(true); });
el.again.addEventListener('click', () => load());
el.bestOf.addEventListener('change', () => load());
el.seed.addEventListener('change', () => load({ keepSeed: true }));
el.speed.addEventListener('input', showSpeed);
el.closePodium.addEventListener('click', () => el.podium.classList.add('hidden'));

el.viewGraph.addEventListener('click', () => setView('bracket'));
el.viewMatch.addEventListener('click', () => setView('matchups'));
el.zoomIn.addEventListener('click', () => { zoom = Math.min(1.6, zoom + 0.1); applyZoom(); });
el.zoomOut.addEventListener('click', () => { zoom = Math.max(0.25, zoom - 0.1); applyZoom(); });
el.zoomFit.addEventListener('click', fitZoom);

el.rosterBtn.addEventListener('click', () => {
  el.rosterText.value = (roster || data.roster).join('\n');
  el.rosterModal.classList.remove('hidden');
  el.rosterText.focus();
});
el.rosterCancel.addEventListener('click', () => el.rosterModal.classList.add('hidden'));
el.rosterReset.addEventListener('click', async () => {
  const r = await (await fetch('/api/roster')).json();
  el.rosterText.value = r.roster.join('\n');
});
el.rosterSave.addEventListener('click', () => {
  const list = el.rosterText.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (list.length < 4) { alert('Need at least 4 entrants.'); return; }
  roster = list.slice(0, 32);
  el.rosterModal.classList.add('hidden');
  load();
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') { e.preventDefault(); if (!el.play.disabled) setPlaying(!playing); }
  if (e.key === 'Escape') {
    el.podium.classList.add('hidden');
    el.rosterModal.classList.add('hidden');
    el.ioModal.classList.add('hidden');
    el.batchModal.classList.add('hidden');
  }
  if (e.key === 'ArrowRight' && !el.step.disabled) { setPlaying(false); stepOnce = true; }
  if (e.key === 'm' || e.key === 'M') setView(view === 'matchups' ? 'bracket' : 'matchups');
});

showSpeed();
applyViewChrome(view); // the board is absolutely positioned and needs its container set up
loadWeights();
load();
