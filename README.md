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

By default matches are pure coin flips. The Matchups tab lets you weight any
pairing against any other.

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

## The board

The classic bracket tree, with SVG connectors running from each match to the one
it feeds. Solid lines advance a winner; dashed purple lines are drops falling
from the winners bracket into the losers bracket. Zoom with − / Fit / +.

You can duck into the Matchups tab mid-run and come back — the board rebuilds
and silently catches up to the exact beat you were on.

## Matchup weights

The third tab (`m`) is a matchup chart: an n×n grid where each cell is the
chance the **row** beats the **column** *in a single game*. Anything left at 50
is an even coin flip.

Editing one side sets the other automatically — putting 54 in Crimson Desert vs
Dungeon Settlers defines the reverse as 46 — so the two halves of the chart can
never contradict each other. Weights are stored per entrant *name*, so they
survive roster edits, and they persist in `localStorage`. Export/Import moves
them as JSON if you want to version a chart or keep several.

**Non-transitive charts are allowed and expected.** A beats B, B beats C, C beats
A is a perfectly valid matchup triangle, and nothing tries to "correct" it.

### Per-game, not per-series

The weight is applied to each individual game, so a series amplifies it — the
longer the series, the more the better matchup is favoured. A 60% per-game edge
becomes:

| Format | Series win rate |
|---|---|
| Bo1 | 60.0% |
| Bo3 | 64.8% |
| Bo5 | 68.3% |
| Bo7 | 71.0% |

So a number you tune under Bo3 will mean something different if you switch to
Bo5. That is the intended behaviour — it is how real series work — but it is
worth knowing before you wonder why a 54% matchup looks stronger than 54%.

### Sim N times

One bracket is a single sample of a very noisy process — a 97%-rated game can and
does go out in the first round. **Sim** runs the current configuration (roster,
weights, best-of) N times server-side and reports the distribution: titles, title
share, how often each entrant reached the grand final, average finishing place,
best-ever finish, and overall series win rate.

Defaults to 100. Accepts 2–50,000; anything outside that is clamped and the box is
corrected to show what actually ran. 50,000 tournaments take about 700ms.

The header line also gives the shape of the format itself — average series and
games per run, and how often the grand final went to a bracket reset (~48%, which
is about right when the two finalists are closely matched).

### Proving the weights are live

**Verify** re-runs the current configuration 2,000 times headlessly and reports,
for every weighted pairing, the rate actually observed across all games played
against the rate you set — plus how many games and meetings that came from. A
gap under ~2 points is sampling noise; a systematically wrong number would show
up immediately. It takes about 50ms.

Within a single run the weighting is visible without any extra chrome:

- the play-by-play opens with `Matchup weights ACTIVE on N pairings`
- a weighted match's card shows an odds chip (`75/25`)
- each weighted result is annotated `· 75% favourite` / `· 25% underdog`
- the podium totals end with `N weighted matchups applied`

Note that a matchup favourite can still be a seeding *upset* — those are separate
things and are labelled separately.

## Steam Pro Tour

The Matchups tab can build a field and a whole matchup chart from **real Steam
review data** instead of hand-typed numbers.

```bash
node steam/fetch-steam.js              # the curated default field
node steam/fetch-steam.js --chart 30   # top 30 most-played instead
```

That writes `steam/snapshot.json`. In the app: **Matchups → Load Steam field →
Apply**. The field lands in the roster, the chart fills in, and everything
downstream — Verify, the bracket, the odds chips — works unchanged.

### The default field

`DEFAULT_TARGETS` in `steam/fetch-steam.js` is the curated field below. Edit that
array to change it — each entry is a display name plus one or more appids:

| Entrant | Steam entry | reviews | Wilson |
|---|---|---|---|
| Subnautica | — | 379,649 | 97.04% |
| KCD2 | Kingdom Come: Deliverance II | 194,797 | 93.82% |
| RimWorld: Odyssey | DLC | 3,323 | 88.57% |
| Onimusha | Onimusha: Way of the Sword | 9,799 | 87.58% |
| They Are Billions | — | 51,409 | 84.81% |
| Crimson Desert | Crimson Desert Enhanced | 171,740 | 83.60% |
| The Blood of Dawnwalker | — | 13,289 | 82.84% |
| The Sinking City 2 | — | 1,596 | 80.97% |
| STALKER 2 | Heart of Chornobyl | 139,775 | 79.63% |
| RimWorld: Anomaly | DLC | 3,047 | 78.66% |
| Project PITT | Project P.I.T.T. | 926 | 76.54% |

An entry may list **several appids, in which case their review counts are summed**
and they compete as one entrant. Nothing in the default field does that any more,
and that is deliberate — a merge produces a weighted average describing neither
game:

- Subnautica bundled with its Early Access sequel (90.91%) scored 95.52%, a
  1.5-point drag on the 97.04% it earns alone.
- RimWorld's two DLCs merged to 84.19%, hiding a **9.91-point** gap between
  Odyssey (88.57%, 3rd in the field) and Anomaly (78.66%, 10th).

Only merge when the parts genuinely are one competitor.

Names deliberately match `DEFAULT_ROSTER` in `sim.js`, so the derived weights key
straight onto the built-in roster.

Curated picks skip the `type` and name filters (a deliberate choice is taken at its
word — that is how RimWorld's DLC entries survive) and default to
`--min-reviews 0`. Those filters only apply in `--chart` mode.

Sample size matters here: Project PITT loses 2.73 points to the Wilson adjustment
on 926 reviews and The Sinking City 2 loses 1.93 on 1,596, while Subnautica's
379,649 barely move it at all.

### Where the data comes from

**Not SteamDB.** It has no public API and its FAQ explicitly prohibits automated
access ("there's a chance you'll get automatically banned for doing so"), pointing
people at Valve instead. So this uses Steam's own public endpoints, no API key:

| Endpoint | Used for |
|---|---|
| `ISteamChartsService/GetMostPlayedGames` | candidate appids + peak players |
| `store.steampowered.com/api/appdetails` | name and `type` |
| `store.steampowered.com/appreviews/<id>` | `total_positive` / `total_reviews` |

`steam/fetch-steam.js` is the **only** thing that ever contacts Steam. The app
reads the committed snapshot, so it is reproducible, works offline, and hits no
rate limits. (It also sidesteps the fact that these endpoints send no CORS header,
so a browser could never call them anyway.)

Filtering drops non-games by `type` (this is what catches FiveM, an `advertising`
entry), names matching playtest/demo/server/SDK/soundtrack, and anything under the
review minimum.

### The stat: Wilson lower bound

Raw `positive/total` is a trap — it ranks a game with 9 positive reviews above one
with 950,000. The score used is the **Wilson 95% lower confidence bound**, which
asks "what is the lowest true rate consistent with this sample?" Small samples get
pulled toward 50%, large ones barely move:

| | reviews | raw | Wilson |
|---|---|---|---|
| a 9/10 indie | 10 | 90.00% | **59.58%** |
| FiveM | 352 | 92.05% | **88.74%** |
| Stardew Valley | 1,037,015 | 98.48% | **98.46%** |

SteamDB itself used this measure for years. Only raw counts are stored in the
snapshot — every score is derived at load time, so the knobs stay live without
re-fetching.

### Competitiveness (the knob that matters)

Scores become per-game weights through a Bradley–Terry model on log-odds:
`P(a beats b) = sigmoid(k · (logit(a) − logit(b)))`.

**`k` is not cosmetic.** At `k = 1` real review spreads are brutal — the widest
pairing in a live top-16 field comes out at 96% per game, which is **99.6% over a
Bo3**. The bracket would be decided at seeding. Measured across 2,000 tournaments
on the real field:

| k | best-reviewed game's title share | verdict |
|---|---|---|
| 0.5 | 36.0% | favourite-heavy |
| **0.3** (default) | **22.9%** | competitive, all 16 games win some |
| 1.0 | — | effectively deterministic |

**Cap** clamps every pairing away from certainty (default 25%, so nothing is worse
than 25/75). The preview line warns you when the cap is binding.

Remember a series amplifies any per-game edge, so these weights are deliberately
compressed relative to intuition.

### Why there are no draws

A bracket edge advances exactly one competitor, and a drawn match would leave
the next slot, the losers-bracket drop, and the elimination count all undefined —
nobody would ever be eliminated. Every real knockout format that permits draws in
league play resolves them at the bracket stage with a tiebreak, so "draws in a
bracket" is really "a tiebreak rule". Weights change *how often* someone wins,
never *whether* the match resolves. If you want draws to carry meaning, the place
for them is a group stage with a points table feeding into the bracket.

## Controls

| Control | What it does |
|---|---|
| **Bracket / Matchups** | Switch tab (`m`), safe to do mid-run |
| **Load Steam field** | Build the roster + chart from Steam reviews (Matchups tab) |
| **− / Fit / +** | Zoom the bracket view |
| **Play / Pause** | Start or hold the playback (`space`) |
| **Step ›** | Advance one beat while paused (`→`) |
| **Skip to end »** | Jump straight to the result |
| **New draw** | Fresh random seeding and a brand-new tournament |
| **Sim N ×** | Run the current setup N times and show the distribution (default 100) |
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
| `steam/fetch-steam.js` | Snapshot fetcher — the only thing that contacts Steam |
| `steam/snapshot.json` | Committed review data (raw counts only) |
| `sim.js` | Simulation engine — seeded RNG, bracket, `wilsonLower`, `weightsFromScores` |
| `server.js` | Static file server + `/api/simulate`, `/api/verify`, `/api/steam` |
| `public/index.html` | Markup |
| `public/style.css` | Styles |
| `public/app.js` | Bracket renderer, matchup editor, playback engine |

Match boxes follow a `.match[data-id][data-round-key]` contract holding
`.slot[data-side]` rows and a `.pips` strip, which is what the playback engine
drives — it never needs to know how the board was laid out.

### API

`GET /api/simulate?seed=<uint32>&bestOf=1|3|5|7&roster=A|B|C`

`POST /api/simulate` with a JSON body — the form the app uses, because a weight
table is too big for a query string (n entrants means n(n−1)/2 pairings):

```json
{
  "bestOf": 3,
  "seed": 12345,
  "roster": ["Onimusha", "KCD2", "..."],
  "weights": [["Crimson Desert", "Dungeon Settlers", 54]]
}
```

Every field is optional. A weight triple reads "first beats second N% of games";
the reverse direction is derived, so you only ever state each pairing once.
Returns the bracket skeleton, the event timeline, and the seed used. Useful on
its own if you want to batch-run tournaments:

```bash
node -e "const{simulate}=require('./sim');const w={};for(let i=0;i<2000;i++){const e=simulate({bestOf:3}).events.at(-1);w[e.champion]=(w[e.champion]||0)+1}console.table(w)"
```

`GET /api/steam` returns the committed review snapshot (raw counts only; every
score is derived client-side so the tuning knobs stay live). 404s with a hint if
`steam/fetch-steam.js` has not been run.

`POST /api/batch` with `{ runs, bestOf, roster, weights }` runs the configuration
`runs` times (2–50,000, default 100) and returns per-entrant `titles`, `titlePct`,
`finalPct`, `avgPlace`, `best` and `winRate`, plus `resets`, `avgSeries` and
`avgGames`. This is what the Sim button calls.

`POST /api/verify` with `{ bestOf, roster, weights, runs }` runs the same
configuration `runs` times (100–20,000, default 2,000) and returns per-pairing
`setPct` / `observedPct` / `games` / `series`. This is what the Verify button
calls; it is also useful on its own for checking a chart before committing it.
