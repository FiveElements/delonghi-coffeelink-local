# AGENTS.md
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

# Project
An Ayla **LAN-mode server** + web UI that drives a De'Longhi ECAM coffee machine entirely locally,
with no cloud. Developed against a Primadonna Soul ECAM 610.75.MB. `README.md` covers what it does
for a user; this file covers what you need to know to change it.

## The two facts the whole design follows from

1. **LAN mode inverts the roles.** This server does not connect to the machine — the machine
   connects to *us*. We announce an address (`SERVER_IP`) and it opens the sessions. So `SERVER_IP`
   must be reachable *from the machine's network*, and `machine → server:3000` must be allowed by
   the firewall. This is the first cause of "nothing works".
2. **The machine picks up exactly ONE command per visit** to `/local_lan/commands.json`. There are
   never two frames in flight. That is the only structural mutual exclusion in the system, and the
   whole scheduler (`src/lib/tasks.ts`) exists to make it explicit rather than accidental.

Commands reach a real appliance. Anything physical or persistent is confirmed before it is sent,
and a failure is reported as a failure — never as a fake success.

## Commands

Node **≥ 26** (the store uses native `node:sqlite`), pnpm 12 (pinned by `packageManager`, and `docker/pnpm/` must carry the same version).

```bash
pnpm install
pnpm dev        # node server.ts --dev  — Next HMR for pages, raw HTTP for device endpoints
pnpm build && pnpm start
pnpm lint       # oxlint, the whole repo: .ts, .tsx, .js (see § Lint)
node_modules/.bin/tsc --noEmit
# can Node erase every type? (`node --check` cannot: it reads a .ts as plain JS)
node --disable-warning=ExperimentalWarning -e 'const{stripTypeScriptTypes:s}=require("node:module"),{readFileSync:r}=require("node:fs");for(const f of process.argv.slice(1))try{s(r(f,"utf8"))}catch(e){console.error(f+": "+e.message);process.exitCode=1}' server.ts debug-capture.ts src/lib/*.ts scripts/*.ts
```

**Everything is TypeScript, and nothing is built.** Node 26 runs `server.ts`, `src/lib/*.ts` and
`scripts/*.ts` directly by *type stripping*: it erases the annotations and runs what is left. Three
consequences, each enforced by `tsconfig.json`: only **erasable** syntax (`erasableSyntaxOnly` — no
`enum`, `namespace`, parameter properties); a type-only import **must** be `import type`
(`verbatimModuleSyntax` — Node drops imports without knowing types, so a plain import of a type
fails at load); relative imports carry their real `.ts` extension (`allowImportingTsExtensions`).
`moduleResolution` stays `bundler`, not `nodenext`: the pages are bundled by Next and import
without extensions (`./machine`, `@/ui/…`), which `nodenext` refuses outright. The one file left
in JS is `scripts/verif-proprietes.js`: Scorecard Fuzzing only recognises `fast-check` in a `.js`.

`next dev` alone is **wrong**: it bypasses `server.ts`, and the ESP32's HTTP client rejects the
App Router's response framing. `pnpm dev:next-only` exists for pure page work only.

### Verification — there is no test framework

Each check is a standalone, dependency-free script. Running one script *is* "running a single test".

```bash
node scripts/verif-tasks.ts       # scheduler: ranks, preemption, sustain windows
node scripts/verif-monitor.ts     # monitor decoding, replayed on REAL captured frames
node scripts/verif-lansession.ts  # both LAN-session roles talking to each other
node scripts/verif-proprietes.js   # fast-check: random frames never crash a decoder; LAN session round-trips any payload (.js on purpose: Scorecard Fuzzing)
node scripts/verif-apps.ts        # app registry + payload parsing
node scripts/verif-args.ts        # ECAM frame table / argument decoding (byte offsets)
node scripts/verif-transfert.ts   # writing a local recipe into a machine slot
node scripts/verif-compteurs.ts   # named-counter table: beverage ids read back out of the property names, water divisor
node scripts/verif-messages.ts    # literal next-intl keys exist in messages/fr.json
node scripts/verif-contraste.ts   # WCAG + ΔL* of both finishes, read back out of globals.css
node scripts/verif-images.ts      # both artwork fingerprint chains — beverages AND beans (producer → table → URL → cache rule)
node scripts/verif-datum-grains.ts # sniffing a bean photo pulled from the Ayla datum (type from bytes, not from a claim)
node scripts/verif-bean-adapt.ts  # BOTH Bean Adapt rules, each against a recorded matrix: refine on 9 cells, create on all 8
node scripts/verif-surfaces.ts    # the 12 surfaces in a REAL headless Chrome (see § Styling)
node scripts/verif-mcp.ts         # MCP server: catalog drift, token auth/scope enforcement, a real start_beverage round-trip through fausse-machine.ts
```

These exist because the modules they cover are **pure**, and the errors they catch are the silent
ones: a one-byte offset or a swapped key direction raises nothing — it produces plausible, wrong
values. Keeping those modules pure is what keeps this possible.

`verif-surfaces.ts` is the one exception and it is deliberate: it seeds a throwaway SQLite
database, boots `server.ts` on port 3127 and drives a real Chrome (`puppeteer-core` — plain
`puppeteer` is refused, third-party install scripts are blocked by `pnpm-workspace.yaml`; point
`CHROME_PATH` at a binary if it is not in the usual place). It covers what only a browser can
answer — a focus trap, an Escape key, an inert background, a face that is `inert` because it is
turned away, a `box-shadow` that a layer silently overrode. **Nothing in `src/ui` or `surfaces.css`
ships without it green.**

Live diagnostics and loopback rigs, when a real behaviour is in question:

```bash
node --env-file=.env.local debug-capture.ts       # standalone LAN server on :3005, VERBATIM log
PROXY_APPS=1 SERVER_PORT=3099 node server.ts      # multiplexer, end to end on loopback:
node scripts/faux-app.ts --serveur 127.0.0.1:3099 --port 8888
node scripts/fausse-machine.ts --serveur 127.0.0.1:3099
node scripts/extract-models.ts                    # regenerate the APK-derived tables
node scripts/extract-catalogs.ts
node scripts/extract-images.ts
node scripts/import-bean-images.ts                # bean artwork, from De'Longhi's S3 (--json replays it offline)
node scripts/extract-bean-creation.ts             # the 8 cells of getBeanSystem.sr (--brut replays them offline)
```

`.github/workflows/ci.yml` runs all of the above plus the SQLite migration chain (v1→v2→v3 on
fabricated databases) and a Docker smoke test. Read it before adding a check — it is the closest
thing to a spec of what can be proven without a coffee machine.

## Architecture

### `server.ts` is the real server, in every mode

~5 500 lines, and the single entry point. It handles in raw `node:http`, before Next ever sees the
request: `/ota_status.json` + `/local_lan/lan_ota` (logged, never served), `/regtoken.json` +
`/local_reg.json` (only when the multiplexer is on), `/local_lan/*` (device-facing), `/api/*`
(control API, ~35 endpoints). Everything else falls through to the Next handler — **pages only**.

### No Next route handlers — on purpose

There used to be `src/app/api/*/route.ts`, `src/app/local_lan/**/route.ts` and the `src/lib/*.ts`
they imported (`config`, `session`, `crypto`, `ecam`, `machine`, `program`, `recipes`,
`keepalive`): an early port, **dead at runtime** because `server.ts` intercepts those paths first,
yet type-checking so they looked alive. They were deleted. Do not add a `route.ts` under `/api` or
`/local_lan` — it would never run.

### `src/lib` — the pure core

| Module | Role |
|---|---|
| `tasks.ts` | the scheduler (pure: the instant is always a parameter) |
| `ecam-args.ts` | the ECAM protocol reference: op table, frame reading, argument decoding. Anything that *names* a command reads this table. **Isomorphic** — no `Buffer`, because `/pilotage`'s journal decodes frames in the browser |
| `beverages.ts` | per-model beverage catalog, Ayla property namespace, recipe bounds |
| `ingredients.ts` + `transfert.ts` | what actually goes into a persistent recipe write |
| `trame-bornes.ts` | bounds-frame encoding |
| `monitor.ts` | real-time state / sensor / alarm decoding |
| `compteurs.ts` | the named-counter table: which Ayla property counts what, and how to read its value |
| `profiles.ts` | profile names, favourites, checksums, Bean System |
| `bean-adapt.ts` | **two** rules, both De'Longhi's: `computeBeanAdapt` refines an existing bean (a rule derived by sweeping the backend), `composeGrainNeuf` composes a new one (a recorded 8-cell table, `bean-creation.json`) |
| `lansession.ts` | LAN session crypto, both roles (client *and* device) |
| `appregistry.ts` + `appproxy.ts` | multiplexer state and payloads |
| `machine-models.ts` | model identification from the serial number |
| `store.ts` | SQLite persistence (the one impure module) |

Frame constructors live in `server.ts`, decoders in `ecam-args.ts`. They **must** read the same
table — a drift between them is invisible at runtime.

### Scheduler semantics

One queue per machine. A task is a list of steps plus a policy; four ranks, and one preemption rule:
a task may be suspended *at a step boundary* by a strictly higher rank. Three wait natures:

- `prop` — an Ayla property read: wait for the machine to POST *that* property;
- `reponse` — a reading ECAM command (`0x75`, `0xA2`, `0xA3`, `0xA6`, `0xB0`, `0xBA`): wait for any
  `data_response`;
- `fenetre` — an *acting* command (`0x84`, `0x83`, `0xA9`, `0xBB`, `0xB9`): nothing comes back, so
  `ms` is a **sustained-presence duration** — reaching it is success, not a timeout.

`device_connected` is served first and then every fifth visit, or the machine stops considering us
present. Presence-sustaining frames must be side-effect free: **`0xA9` selects a profile**, so using
it as a heartbeat silently forces profile 1.

### The journal — an append-only stream, not a list that gets re-downloaded

`L()` / `LA()` take a **subject and a summary as two arguments**, not one sentence: the subject is a
*column* in `/pilotage`, and that alignment is what lets you scan a journal instead of re-reading
fifty phrases. Deducing it at render time — cut at the first `:` — worked on the messages that
follow the convention and left an empty column on the others, silently. The signature makes it
impossible to add a line without one. A line also carries the **frame as base64**, never a decode.

Each entry is `{id, n, t, source, dir, sujet, resume, m, app, repetitions, trame}`, and **`id` and
`n` are two different things**. `id` names the line forever; `n` dates its last touch. Folding a
consecutive repetition mutates the head in place (`repetitions++`) and gives it a fresh `n` so it
travels again — but its `id` does not move, so the browser **replaces** the line it already has
instead of stacking a twenty-fourth copy. Without that split, repetition folding — the one thing
that keeps a journal readable when everything is on fire — is exactly what the stream would break.
The sequence is shared by both journals: the browser holds one cursor.

The transport: `GET /api/journal` once at mount, then a **named SSE event** (`event: journal`) on
the connection that is already open. `EventSource.onmessage` only receives *anonymous* events, so
the six pages on `useMachineEvents` see nothing new — by construction, not by care. Each frame
carries an `id:`, so the browser sends `Last-Event-ID` on reconnect and the server replays from
there; a cursor older than the last evicted line gets the whole window back, marked `complet`, and
the client replaces rather than appending to a holed timeline.

Measured on the test machine before this: `/api/status` weighed **8 185 bytes, of which 5 685
(69 %) was journal** — 50 lines re-downloaded whole on every SSE push, i.e. every 250 ms during a
preparation, for ~114 bytes of new information. The journal has left that response. A push now
carries **~400 bytes for two lines**; the initial window is 3 152 bytes, once. And filters work on
the full 400-line window the client holds, so "no result" can never mean "only the last fifty".

⚠️ **`ecam-args.ts` no longer knows `Buffer`, and that is what makes it usable in a browser.** It
ran one at *load* time (the `0x37` constant), so importing it from a page threw before the first
line of render and `/pilotage` came up blank with nothing saying why. The journal's drawer decodes
a frame client-side, and it must do it with *that* table, not a copy — hence `Uint8Array` and
`atob`, available on both sides. The server keeps its `Buffer`s everywhere else; they index alike.

### Statistics come down TWO channels, and they do not overlap

`0xA2 0x0F` returns bare parameter ids (100, 3000, 23004…) — 62 of them on the reference machine,
ten with an established meaning. That is `STAT_MEANINGS` + `STAT_RANGES` in `server.ts`.

The other channel is **named Ayla properties** (`src/lib/compteurs.ts`): `d553_water_tot_qty`,
`d701_tot_bev_bw`, `d705_tot_id1_espr`… The official app reads both — `p258z7/w.java` has one method
per channel — and this server now does too. Six of those names carry the same quantity as an
already-identified `0xA2` parameter, which is what makes the pairing checkable on a single reading;
that is the cheapest remaining lever on the 52 nameless ids.

⚠️ **`d553_water_tot_qty` divides by 2000, not 1000.** The unit is the half-millilitre, same as
parameter 106: the app does `u.a(v) = v × 0.5` then `/1000`, and writes `parseInt(str) / 2000`
outright in its datapoint branch. The Home Assistant integration `actabi/delonghi_coffeelink`
divides by 1000 — its litres are twice too large. Do not import that value from it; part of the
name table does come from that project, and this is the one number in it that is wrong.

⚠️ **Two sources, and they do not carry the same weight.** `source: "apk"` means the name is written
in the app binary — 14 names. `source: "eletta"` means it comes from a real Ayla property dump of an
Eletta Explore 450.65.G published by that HA integration: it proves the property exists on *that*
appliance, nothing more. The distinction travels all the way to the screen, and only the non-binary
ones are marked there. A name that answers empty once is recorded `absent` and never asked again —
without that, the wide scope would send 40 steps per click to bring back the same 14 answers.

⚠️ **The Eletta dump also bounds a claim this UI makes.** `d705_tot_id1_espr` … `d730_tot_id27_…`
are **per-beverage** counters, and the id in the name is this repo's own catalogue id. "The machine
counts by category, not by beverage" is true of the `0xA2` space on the ECAM 610.75.MB; it is not
true of the range.

### Storage

One SQLite file (`data/lan-server.db`; `DATA_DIR` / `DATABASE_FILE`), WAL + `synchronous = FULL` +
`STRICT` tables. Each received property is one upserted row, not a rewritten 80 kB blob. Schema v4
(v3 → v4 added `mcp_tokens`, for MCP API tokens); migrations run automatically at boot and announce
themselves through `bootMessages`. Every data
table carries a `machine` column with `ON DELETE CASCADE`; machine-independent settings live in
their own `settings` table.

A bean's photo has **two possible origins**, both landing under the same `s<n>` key: cropped here
by `PhotoGrains` (WebP 300×340), or pulled from the cloud by `POST /api/beans/visual/import` — the
Ayla datum `BS<index>IMG`, where the index IS byte 4 of the `0xBA` frame (`profiles.ts` reads
`index: buf[4]`; the app formats `BS%sIMG` with the same byte). That import is this server's
**fourth** cloud path after the LAN key, OTA and the session, and like them it is an explicit act,
never a side effect of a page load. What it brings back is the app's format, not ours: JPEG q35,
5:3 stored from a 3:2 crop — a measured 10% vertical squash (1394×836 on the machine tested). So
`FORMAT_IMAGE` describes what our UI *produces*, never what the table *contains*.

⚠️ **`bean_images.id` holds two namespaces, on purpose.** `b1`, `b2`… are server-side bean
presets; `s1`…`s6` are the machine's own slots. The prefix is what keeps a `b3` and an `s3`
apart, and it is what let slot visuals ship without a schema v4 for one column. Roast levels —
which the machine never stores — live in `meta`: inside each preset for a preset, under
`meta.beanRoasts` keyed by index for a slot. A slot's visual follows the **index**, not the bean:
nothing tells us the appliance was renamed.

### Bean Adapt is TWO rules, and each is verified against a recording

The appliance's own flow has two halves, and they ask different questions:

| | Questions | De'Longhi endpoint | Ours |
|---|---|---|---|
| **refine** an existing bean | crema (`question_1`), taste (`question_2`), measured flow time | `getBeanSystemAdv.sr` | `computeBeanAdapt` |
| **create** a new bean | blend (`prequestion_1`), roast (`prequestion_2`) | `getBeanSystem.sr` | `composeGrainNeuf` |

The refine rule is a *rule*, derived by sweeping the backend and replayed against a nine-cell
matrix (`docs/bean-adapt.md` §4.4). The creation rule is a **table**: the input space is 2 × 4, so
it was recorded whole — 8 requests, no authentication, `scripts/extract-bean-creation.ts` on
2026-09-02 — and frozen into `src/lib/bean-creation.json`. `composeGrainNeuf` **reads** it.

⚠️ **Do not factor that table into a formula.** `grinder = robusta ? 3 : 4` is exact today and
reinvents seven of the eight points the day one cell changes. `verif-bean-adapt.ts` holds a
*second* transcription of the recording, typed in from the raw log: comparing the function's output
to the very JSON it reads would only prove an array access, whereas the copy fails the script if the
generated file is hand-edited.

⚠️ **The creation rule was OURS for one day, it was labelled as such, it was green — and it was
wrong on both axes.** Before the sweep, `composeGrainNeuf` computed `2 + roast` for the grind and
keyed temperature/aroma off the blend; eight coherence tests asserted that intention (grind strictly
increasing with roast, robusta coarser and cooler) and all passed. The recording says the opposite:
**the grind depends only on the blend** (robusta is *finer*, 3 vs 4), **temperature and aroma depend
only on the roast**, and the four roast levels **collapse into two buckets**. That is the exact limit
of verification without an oracle — it proves code does what it says, never that what it says is
true — and the reason 8 requests were worth more than eight tests.

What the screen shows follows `source` in the response (`"delonghi"` + the sweep date), never a
hard-coded sentence. Both branches are still in the dialog: getting a number's origin wrong, in
either direction, is invisible. The questionnaire itself never touches the network.

⚠️ **`getBeanSystem.sr` is NOT dead code, whatever `docs/bean-adapt.md` §3.2 used to say.** Its two
callers live in methods JADX gives up on (`Method not decompiled`, 958 and 369 instruction units in
`L6.j$b$a` / `L6.j$d$a`), so a `grep` over `decompiled/sources/` finds nothing and concludes wrongly.
Read at the bytecode level (`dexdump -d` on `classes2.dex`): `L6.j.C(1, …)` dispatches on its `int`
argument — `1` builds a `BeanChoice` from questions 1 and 2, `2` builds a `BeanAdvanceChoice` from
questions 11 and 12. Both run on every bean creation.

Two more findings from that same read, for whoever ports more of this flow:

- the creation call sends **question 11 hard-coded to answer `2`** (dark crema, Δtemperature = 0) —
  the creation flow never asks about crema;
- of the three values the basic call returns, the app keeps temperature and aroma but **discards the
  grinder**, substituting the grind the user picked by hand; it then writes parameter **61** (coffee
  temperature) to the machine and pins the `TASTE` parameter of beverage **200 (« Espresso BS 1 »)**
  with `setDefValue = setMinValue = setMaxValue = aroma`.

### Several machines

Machine ids are **ours** (`m1`, `m2`…), not the DSN — the DSN is only discovered after an address is
entered. The browser keeps the current machine in `localStorage` (a per-browser display preference,
deliberately not server state) and every API call carries `?machine=`. Always go through `mfetch`
in `src/app/machine.ts`; a bare `fetch` targets the server's *default* machine. Two limits, stated
in the UI: the `MACHINE_*` / `LANIP_*` env vars describe only the first machine, and the beverage
catalog is one model's, shared by all — a mismatch is reported, not corrected.

### Model detection, and generated tables

`d270_serialnumber` characters 1–5 index the manufacturer table (`0132217055` → `17055` →
ECAM 610.75.MB) — no cloud involved. `machine-models.json`, `machine-catalogs.json` and
`beverage-images.json` are **generated** by `scripts/extract-*.ts` from the APK (oxlint ignores the
first two). Never hand-edit them; change the script. **Two more are generated from a *network*
source**, and each has an offline replay flag so the decoding can be re-checked without calling out
again: `bean-images.json` from De'Longhi's questionnaire S3 (`scripts/import-bean-images.ts
--json`), which names the four roast-level visuals and the three crema ones, and
`bean-creation.json` from `getBeanSystem.sr` (`scripts/extract-bean-creation.ts --brut`), the 8
cells of the bean-creation rule. That script writes **no table at all** if one cell fails: a table
with seven cells out of eight would make the eighth setting up, which is the failure this whole repo
is built to avoid.

### App multiplexer — off by default

`PROXY_APPS=1` makes this server answer `/regtoken.json` and `/local_reg.json` as the machine would,
so several apps can share the machine's **single** `local_reg` slot (an official app on the network
evicts us with no error and no signal at all). It is opt-in because impersonating a device is an
explicit act, not a side effect of an upgrade. Apps build URLs as `http://<ip>/` with no port, so
they only ever look on **port 80** — listen there or redirect, otherwise nothing arrives.

### MCP server

`/mcp` (Streamable HTTP) exposes the same control API as an MCP tool catalog. The tools live in
`server.ts` itself, next to `handleApi` — not a separate `src/lib/mcp-tools.ts` — because each
tool closes over the same module-level mutable state (`MACHINES`, the scheduler, `CFG`) that
`handleApi` already closes over; splitting them into a pure module would mean passing all of that
back in, for no isolation actually gained. An action tool must refuse exactly when the HTTP route it
wraps would refuse — see `resolveMachineForAction`, next to `resolveMachineForTool` — never a
misleading success for a command that will never reach the machine.

⚠️ **The token system is a *scoping* mechanism, not a network boundary.** `/api/mcp-tokens` is
itself unauthenticated, like the rest of `/api/*`: anyone who can reach the server can mint their
own all-scopes token, or skip tokens entirely and call `/api/command` directly. What a token buys is
narrowing what an *already-trusted* agent is allowed to do — never keeping an untrusted caller out.

## Front-end conventions

Next 16 App Router, React 19, TypeScript 7, `next-intl`. **Code, comments and UI are in French**,
with dense "why did this end up like this" headers — match that register.

- Single locale, **no locale prefix** in URLs: a `[locale]` segment would move every page for no
  benefit while `server.ts` intercepts `/api` and `/local_lan` upstream.
- The API sends **stable protocol identifiers** (`slug` for a beverage, the ECAM enum name for a
  parameter) plus a fallback label; the client translates via `src/i18n/labels.ts`. Nothing
  translatable crosses the API. A name typed on the machine ("Grain A") is user data and is
  **never** translated.
- Every physical or persistent action goes through the shared confirmation dialog
  (`src/app/confirm.tsx`, prefs in `confirmPrefs.ts`). Never `window.confirm`: unstylable, and it
  returns `false` in a sandboxed iframe, which makes every button on the page silently inert.
- Anything the machine can change arrives over SSE (`/api/events`, hook in `src/app/events.ts`),
  never by polling — a property read is not synchronous; the machine pushes 2–4 s later.

### Styling: Tailwind 4 + shadcn/ui, and one law about the cascade

**shadcn is the target for every surface**, existing ones included — migrated 2026-08-26. `src/ui`
holds the mounted primitives; `cn()` is `clsx` + `tailwind-merge`; the CLI is configured by
`components.json` (style `new-york`, alias `@/ui`). A `shadcn add` lands in the right world.

Three files, three jobs:

| | |
|---|---|
| `src/app/globals.css` | tokens on `:root` with a `[data-theme="light"]` override, so **dark is the default** — plus the **token bridge** (`@theme inline`) that remaps shadcn's fixed vocabulary onto the boîtier's roles, and the `tactile:` / `court:` / `dark:` variants |
| `src/ui/*.tsx` | the components, each carrying the product's own matter in utilities |
| `src/app/surfaces.css` | what is left: page layout, and the rules no utility can express |

⚠️ **`utilities` beats `surfaces` in the layer cascade — specificity does not enter into it.** This
is the single fact the whole migration turns on. A rule in `surfaces.css` that repaints a component
loses **silently**: it type-checks, it lints, the page renders, and the wrong colour ships. The fix
is always the same — **move the matter onto the component**, as a class or a variant. Every
component in `src/ui` that departs from the CLI's version says in its header what it took over and
why. Paid for once by `.confirm` (57 dead lines) and once by three card modifiers.

⚠️ **Two remaps are product law, not taste.** `--primary` is the **neutral** key, *not* amber: a
command's colour states its FUNCTION (`marche` starts something on the appliance, `arret` stops or
destroys, amber means *chosen*), never its importance. And `--radius` is 2 px, the boîtier's value.

⚠️ **A Radix `Switch` / `Checkbox` / `RadioGroupItem` is a `<button>`, and a `<label>` does not name
a button.** Wrapping one produces an unnamed control, in silence, where the native input got a name
for free. Use `aria-labelledby` pointing at the visible text.

Three native elements were deliberately reversed in that migration — `<select>`, `<dialog>`,
`<input type="range">`. Each was rendering a real service the component now owes:
`scripts/verif-surfaces.ts` checks all three in a real browser (focus trap, Escape, background
inertness, the `--crans` graduation, the profile listbox). Do not weaken those assertions.

⚠️ **The layer cascade bites hardest on a bare `<button>`, and it bit three times in one block.**
`globals.css` declares `@layer theme, base, surfaces, facade, components, utilities`, and
`surfaces.css` is imported into `surfaces` — so anything in `facade` or above wins over it
**whatever the specificity**. The journal's rows are `<button>` when they have a frame and `<div>`
when they do not, which made every one of these visible side by side: `button:not([data-slot])` in
`surfaces` (0,1,1) beat `.journalBascule` (0,1,0) on `padding`, so rows came out 4 px wider than
their own header; and `button, input, select, textarea { font: inherit; line-height: 1.2 }` in
**`facade`** beat even `button.journalBascule:not([data-slot])` (0,2,1) on `font-size`, so lines
with a drawer rendered at 16 px next to their neighbours at 12. Specificity cannot answer the
second one — only moving the matter onto the component can, which is why `CORPS_LIGNE` in
`Journal.tsx` carries the size and leading as utilities. Both are measured in `verif-surfaces.ts`.
And a bare `<select>` / `<input>` inherits **nothing** here: the repo dresses its fields through
shadcn's `[data-slot]`, so use `Input` and `Select` or they ship transparent and 44 px tall.

⚠️ **Two faces in one DOM is two sets of tab stops.** `/beans` cards flip (`src/app/CarteGrain.tsx`):
a poster on the front, everything editable on the back. `backface-visibility` hides a face from the
*eye* only — the turned-away face stays tabbable and readable unless it carries `inert` **and**
`aria-hidden`, and nothing static catches the omission. The back is also mounted lazily (first flip),
so a closed grid has no extra tab stop at all. The plateau's height is **measured in JS** and set in
pixels, because a transition has nothing to interpolate between two `auto`. All of it is asserted in
`verif-surfaces.ts`, § *La carte de grain se retourne*.

⚠️ **The back opens on the SAME frame as the front, and that is what removed its title line.** Both
faces mount one `AfficheGrain` (in `VignetteGrains.tsx`, next to the precedence it wraps) — on the
front as a poster, on the back as the file-picker button (`PhotoGrains`). So the card turns around a
rectangle that does not move, and the name no longer needs a third reading: the `<h3>` on the back is
`sr-only` (removing it outright would drop the card out of the heading outline, since the front is
`aria-hidden` while turned away) and the three things a title line used to carry sit in the poster's
corners — index or date top-left, flip-back top-right, "change the photo" seal bottom-right. Two
traps: an icon-only trigger needs `aria-label` (a `<button>` with no text announces itself as
"bouton"), and **that button-poster must out-specify `button:not([data-slot])`** — the generic bare
`<button>` rule in `surfaces.css` is `(0,1,1)`, so a plain class silently loses its `padding: 0` and
the frame comes out 28 px narrower than the front's. Measured, and asserted.

⚠️ **The five explanatory `.legende` paragraphs on that back are gone on purpose, and a tooltip did
not replace them.** A `title` answers nothing to a finger. What engages the appliance moved into the
confirmation dialog — which is where this repo already puts its warnings, and which shows everywhere;
`title` keeps only the *why*. Section structure (`role="group"` + `.etiquetteGroupe`) replaced two
more, which is why "Le grain" and "Réglages" are real named groups and not decorative headings.
- `verif-messages.ts` only sees **literal** keys written on the spot. A key requested inside a
  helper that receives a translator (`fmtAge(sec, t)`) is invisible to it — that is the very bug
  that motivated it.

## Lint

oxlint (`.oxlintrc.json`, JSON with comments), run as `oxlint --deny-warnings`: a warning fails like
an error. It replaced ESLint 10 for one reason: **oxlint parses TS/TSX natively**. ESLint needs
`typescript-eslint`, which calls the classic compiler API that TypeScript 7 (the native port) no
longer exports, and whose peer range excludes 7 — so under ESLint only the `.mjs` could be linted.
Now the whole repo is, and `react-hooks/rules-of-hooks` + `exhaustive-deps` finally reach the pages.
Since the move to TypeScript, `tsc --noEmit` sees the server too (`server.ts`, `src/lib`, `scripts`),
which it never did while they were `.mjs`; `no-undef` stays on only for the remaining `.js`.

Every rule turned off in `.oxlintrc.json` carries its reason next to it — three React Compiler rules
(the compiler is not enabled here) and `unicorn/no-new-array` (the frame constructors' idiom).
Exceptions are written `// oxlint-disable-next-line <rule>`. The native binary comes through
`optionalDependencies` (`@oxlint/binding-*`), with no install script — nothing to allow in
`pnpm-workspace.yaml`.

⚠️ **A component declared inside a render is a new type on every render**, so React remounts it.
`react/static-components` caught four in `/pilotage` and `/statistiques`, including three
`role="status"` regions whose whole point was to stay mounted. Such helpers are called as
functions (`{statut("power")}`), never mounted as `<Statut />`.

## Secrets and data hygiene

Never commit, publish, or attach to a report: `.env.local`; `data/lan-server.db` (LAN keys, serial
numbers, profile names — treat it as a password file); the workspace's `apk/`, `decompiled/` and
`docs/`. `src/lib/cloud-app.json` is committed on purpose and is not secret.

⚠️ **`public/boissons/` and `public/grains/` were versioned on 2026-09-01, by an explicit decision
of the repository's owner, and that reverses what this section used to forbid.** They are
De'Longhi artwork — extracted from the APK for the beverages, pulled from the questionnaire's S3
bucket for the beans — and this repository is public, so they are now redistributed. The mappings
(`src/lib/beverage-images.json`, `src/lib/bean-images.json`) and the scripts that regenerate them
stay exactly as they were; they are simply no longer the only way to obtain the files. The other
derivations remain ignored (`public/boissons-*/`, `public/boissons-svg/`) — the decision covered
the two directories named above, not every variant one may extract. Removing the images later
takes a history rewrite, not a `git rm`.

Device-specific values in any documentation are written as markers (`IP_MACHINE`,
`AC000W0XXXXXXXX`, `VLAN_IOT`, "Grain A/B"). `scripts/faux-app.ts` is deliberately incapable of
building an ECAM frame — a test tool that can start a hot-water rinse is a dangerous thing to leave
lying around.

## Current state

Commit `c807a2c` ("CLean doc") deleted `CLAUDE.md`, `ETAT.md`, `PRODUCT.md` and the whole `doc/`
tree. `README.md` and many source comments still point at `doc/*.md`
(`analyse-connexion-wifi.md`, `commandes-cafe.md`, `format-trame-boisson.md`,
`materiel-et-firmware.md`, `securite.md`, `spec-proxy-multi-app.md`): those links are dead until
`doc/` comes back. The content is recoverable with `git show c807a2c^:doc/<file>`.

**`doc/bean-adapt.md` is back** — restored from that history and brought up to date when the
creation rule landed, so its link resolves and the other six do not. Restoring another one is the
same two moves: `git show c807a2c^:doc/<file>` for the redacted twin, then reconcile it against
`docs/<file>` on the workspace side, which kept receiving findings while `doc/` was gone. Do not
regenerate a twin from the private version by hand — the markers (`IP_MACHINE`,
`AC000W0XXXXXXXX`, `VLAN_IOT`, "Grain A/B") are what makes it publishable, and the historical
version already has them in the right places.
