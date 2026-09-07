'use strict';

/* ------------------------------------------------------------------ *
 * Tournament Sim - client playback.
 *
 * The server simulates the whole tournament up front and hands back a flat
 * event timeline. Everything here is presentation.
 *
 * Two renderers draw the same tournament:
 *   - "cards"   round-by-round columns, compact and easy to scan
 *   - "bracket" the classic tree, with SVG connectors between matches
 *
 * Both emit the same DOM contract - a .match[data-id][data-round-key] holding
 * .slot[data-side] rows and a .pips strip - so a single playback engine drives
 * either one. Switching views mid-run replays silently up to the current beat.
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
  viewCards: $('#viewCards'), viewGraph: $('#viewGraph'),
  zoomCtl: $('#zoomCtl'), zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), zoomFit: $('#zoomFit'),
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
let view = 'cards';
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

/* ------------------------------ renderer: cards ------------------------------ */

function renderCards() {
  el.board.className = 'board cards';
  el.board.style.cssText = '';
  el.board.textContent = '';

  const lanes = [
    { k: 'W', title: 'Winners Bracket' },
    { k: 'L', title: 'Losers Bracket \u2014 one more loss and you are out' },
    { k: 'GF', title: 'Grand Final' },
  ];

  for (const lane of lanes) {
    const rounds = data.rounds.filter((r) => r.bracket === lane.k);
    if (!rounds.length) continue;

    const wrap = tag('div', 'lane lane-' + lane.k.toLowerCase());
    const hd = tag('div', 'lane-hd');
    hd.append(tag('span', 'dot'), tag('span', null, lane.title));
    wrap.append(hd);

    const cols = tag('div', 'cols');
    for (const r of rounds) {
      const col = tag('div', 'col');
      col.dataset.key = r.key;
      col.append(tag('div', 'col-hd', r.name));
      for (const n of r.matches) col.append(matchBox(n));
      cols.append(col);
    }
    wrap.append(cols);
    el.board.append(wrap);
  }
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
      await wait(T.round, token, instant);
      break;
    }

    case 'round': {
      const boxes = roundNodes(ev.key);
      for (const b of boxes) {
        fill(b, 'a', b.dataset.a, seedMap.get(b.dataset.a), !instant);
        fill(b, 'b', b.dataset.b, seedMap.get(b.dataset.b), !instant);
      }
      for (const c of el.board.querySelectorAll('.col.active')) c.classList.replace('active', 'done');
      for (const g of el.board.querySelectorAll('.glabel.active')) g.classList.remove('active');
      const col = el.board.querySelector('.col[data-key="' + ev.key + '"]');
      if (col) { col.classList.add('active'); scrollTo(col, instant); }
      const lab = el.board.querySelector('.glabel[data-key="' + ev.key + '"]');
      if (lab) lab.classList.add('active');
      if (!col && boxes[0]) scrollTo(boxes[0], instant);

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

      say(ev.winner + ' def. ' + ev.loser + ' ' + ev.score[0] + '-' + ev.score[1] + (ev.upset ? '  (upset)' : ''), ev.upset ? 'up' : null);

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

  if (view === 'graph') renderGraph(); else renderCards();
  el.log.textContent = ''; // the silent replay re-emits every line

  for (let i = 0; i <= upTo; i++) {
    if (token !== run) return;
    await applyEvent(data.events[i], token, true);
  }

  idx = upTo + 1;
  if (view === 'graph') fitZoom();
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
  el.totals.textContent = ev.totals.series + ' series \u00b7 ' + ev.totals.games + ' games \u00b7 seed ' + data.seed;
  if (!instant) el.podium.classList.remove('hidden');
}

/* ------------------------------ control ------------------------------ */

async function load(opts) {
  opts = opts || {};
  run++;
  playing = false;
  fast = false;
  stepOnce = false;
  idx = 0;

  const q = new URLSearchParams();
  q.set('bestOf', el.bestOf.value);
  const s = el.seed.value.trim();
  if (opts.keepSeed && s) q.set('seed', s);
  if (roster) q.set('roster', roster.join('|'));

  el.log.textContent = '';
  el.board.textContent = '';
  el.standings.textContent = '';
  el.progress.style.width = '0%';
  el.phase.textContent = 'Drawing bracket\u2026';
  el.podium.classList.add('hidden');

  const res = await fetch('/api/simulate?' + q.toString());
  const json = await res.json();
  if (json.error) { el.phase.textContent = 'Error: ' + json.error; return; }

  data = json;
  el.seed.value = String(data.seed);
  el.bestOf.value = String(data.bestOf);

  if (view === 'graph') { renderGraph(); fitZoom(); } else renderCards();

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

function setView(v) {
  if (v === view) return;
  view = v;
  el.viewCards.classList.toggle('on', v === 'cards');
  el.viewGraph.classList.toggle('on', v === 'graph');
  el.zoomCtl.hidden = v !== 'graph';
  el.stage.classList.toggle('graph-mode', v === 'graph');
  if (!data) return;
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

el.viewCards.addEventListener('click', () => setView('cards'));
el.viewGraph.addEventListener('click', () => setView('graph'));
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
  if (e.key === 'Escape') { el.podium.classList.add('hidden'); el.rosterModal.classList.add('hidden'); }
  if (e.key === 'ArrowRight' && !el.step.disabled) { setPlaying(false); stepOnce = true; }
  if (e.key === 'v' || e.key === 'V') setView(view === 'cards' ? 'graph' : 'cards');
});

showSpeed();
load();
