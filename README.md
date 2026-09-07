# Tournament Sim

A zero-dependency Node app that runs a double-elimination tournament and plays it
back visually, one match at a time, at whatever speed you want.

```bash
node server.js
```

Then open <http://localhost:5173>. No `npm install` — there are no dependencies.
Set `PORT` to use a different port.

## How it works

The server simulates the **entire** tournament up front and returns a flat event
timeline. The browser just replays that timeline. Two consequences worth knowing:

- Changing the speed never changes the outcome — you're scrubbing a recording,
  not re-rolling dice.
- Every tournament has a **seed**. Paste a seed back into the seed box to replay
  that exact tournament, match for match.

Matches are pure coin flips. Nothing is weighted by how good a game actually is.

## The bracket

A standard double-elimination bracket with fixed slots and standard seeding, so
the top seed draws the bottom seed and #1 and #2 can only meet in the final.
Entrants are seeded **randomly** each draw, then the structure is conventional.

The losers bracket alternates as a real one does: *minor* rounds where
losers-side survivors play each other, and *major* rounds where they meet the
batch that just dropped out of the winners bracket. Drop-ins are reversed
against the survivors, the usual heuristic for delaying rematches.

Because the structure is fixed, every match knows which two matches feed it —
that's what lets the bracket view draw real connectors.

A note on byes: filling a 16-slot draw with 12 entrants means seeds 1–4 skip a
round, and that is a genuine advantage. Over 3000 runs the bye seeds win ~12%
each against ~6.4% for the rest. Per *entrant* it still evens out to ~8.3%,
because the seeding itself is redrawn at random every tournament.

## Two views

**Cards** — round-by-round columns. Compact, everything visible, good for
following the play-by-play.

**Bracket** — the classic tree, with SVG connectors running from each match to
the one it feeds. Solid lines advance a winner; dashed purple lines are drops
falling from the winners bracket into the losers bracket. Zoom with − / Fit / +.

Switch at any time with the toggle or the `v` key, including mid-run — the other
view rebuilds and silently catches up to the exact beat you were on.

## Controls

| Control | What it does |
|---|---|
| **Cards / Bracket** | Switch view (`v`), safe to do mid-run |
| **− / Fit / +** | Zoom the bracket view |
| **Play / Pause** | Start or hold the playback (`space`) |
| **Step ›** | Advance one beat while paused (`→`) |
| **Skip to end »** | Jump straight to the result |
| **New draw** | Fresh random seeding and a brand-new tournament |
| **Speed** | 0.1× to 25×, applies instantly mid-run |
| **Best of** | 1, 3, 5, or 7 games per match |
| **Seed** | Type a seed and press Enter to replay that tournament |
| **Roster** | Edit the entrant list (4–32); redraws on save |

`Esc` closes the podium or roster dialog.

## Reading the board

Rounds cascade left to right, winners bracket on top, losers below, grand final
last. A card pulses amber while its series is live (and in bracket view its
connectors light up too), and the pip row under each card fills in game by game.

- **green** — won the series
- **struck through** — lost the series
- **OUT** — that was a second loss, they're gone
- **UPSET** — lower seed beat a higher seed
- **SWEEP** — won without dropping a game

The sidebar tracks live W–L for everyone and greys out entrants as they're
eliminated. When the losers-bracket winner takes the grand final, the bracket
resets and a deciding series is played.

## Files

| File | Role |
|---|---|
| `sim.js` | Simulation engine — seeded RNG, bracket structure, event timeline |
| `server.js` | Static file server + `/api/simulate` |
| `public/index.html` | Markup |
| `public/style.css` | Styles |
| `public/app.js` | Both renderers + the shared playback engine |

Both renderers emit the same DOM contract — a `.match[data-id][data-round-key]`
holding `.slot[data-side]` rows and a `.pips` strip — so one playback engine
drives either one without knowing which is on screen.

### API

`GET /api/simulate?seed=<uint32>&bestOf=1|3|5|7&roster=A|B|C`

All parameters optional. Returns the bracket skeleton, the event timeline, and
the seed used. Useful on its own if you want to batch-run tournaments:

```bash
node -e "const{simulate}=require('./sim');const w={};for(let i=0;i<2000;i++){const e=simulate({bestOf:3}).events.at(-1);w[e.champion]=(w[e.champion]||0)+1}console.table(w)"
```
