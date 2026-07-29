# The architecture walkthrough (`/walkthrough`)

A full-page architecture diagram, followed by ten topics that each explain one
decision inside it. Reachable from the app via "Documentation" in the practice
nav and in the corner of the sign-in screen.

It is a **real App Router route**, public by design, built on the same design
system as the rest of the app.

| Path | What |
|---|---|
| `app/walkthrough/page.tsx` | the route: metadata and mount, nothing else |
| `components/walkthrough/Walkthrough.tsx` | the shell: header, topic rail, scoped controls, glossary panel |
| `components/walkthrough/mechanisms.tsx` | the 11 animated panels, one per topic |
| `components/walkthrough/content.ts` | all verified data and prose, no JSX |

## Structure: one diagram, ten topics

Page 01 is the architecture: a single SVG diagram of **16 blocks and the 16
connectors between them**, sized to exactly one viewport so it never scrolls.
Three columns (setup, the call, scoring and reading) over a Firestore row that
everything above writes down into. Colour carries the lane, dashed connectors
are reads and solid ones are writes and calls.

Every block is a button. Pointing at one shows what is inside it in the side
panel; clicking it calls `nav(topicId)` and opens the topic explaining it, which
is what makes this usable as a reference rather than only as a sequence.

Two things the layout learned the hard way:

- **The grid ratio has to be close to the box it renders into.** A first attempt
  laid the diagram out at 1500x520, which scaled to 0.54 in the ~810px box it
  actually gets and rendered its labels at 8px. It is now 1000x790, which lands
  near 0.85.
- **No edge labels.** Their midpoints sat on top of blocks. Dashed versus solid
  is explained once, in the side panel, instead.

| # | Topic | What it absorbed |
|---|---|---|
| 01 | Architecture | the whole map, plus the stack list |
| 02 | Before the call | CV parsing, quota, both generation passes, cost |
| 03 | The shared document | field groups, the six-state lifecycle, cron sweeps |
| 04 | One turn | the realtime loop, the latency budgets |
| 05 | One agent, N voices | roster, tag routing, interjection budget |
| 06 | The guards | the tool preconditions, the three corpus attacks |
| 07 | Scoring | split by round, rotate, quote before scoring |
| 08 | Verdict and report | the separate verdict call, the report page |
| 09 | When things break | durable handoff, resume, the abandon race |
| 10 | How it is tested | question harness, exit codes, judge gate, panel sim |
| 11 | Attacks and privacy | the 53-case corpus, telemetry redaction |

### Why it shrank from 25 to 11

An earlier version had 25 stages across four act tabs. Nobody evaluating this
project, recruiter or engineer, is going to click through 25 screens. Anything
that needed two stages to explain turned out to be one stage split in half: the
interjection budget was described on two consecutive stages in nearly identical
words, the exit-code and flaked-fixture stages were one argument, and two stages
drew the same p95 budgets twice.

The act tabs went too. Three tabs to navigate eleven items is a layer of
navigation that has to be explained before it helps.

### Sub-tabs, not more stages

Merged topics hold their parts behind a `SubTabs` toggle inside the panel. This
keeps the rail short without losing anything.

A control in the header usually drives only **one** sub-tab, so changing it
calls `useJumpOnChange` to pull the reader to the sub-tab it actually affects.
Without that, clicking "Grill" while looking at the question harness appears to
do nothing, which is the exact confusion that made the controls feel broken
before they were scoped.

## Built on the app, not beside it

Everything visual comes from `components/ui/*` and the `app/globals.css` tokens,
so the page inherits the product's surfaces, borders, accent and type ramp for
free and cannot drift from them. It uses `Card`, `Badge`, `Button`,
`ToggleGroup`, `Sheet` and `Separator`. Motion is `framer-motion`, a real npm
dependency.

The route sits outside the `(auth)` and `(practice)` groups so it is readable
before anyone has an account, and inherits the root layout, which is where the
`dark` class and the fonts live. There is no theme toggle because the app is
dark only.

## Layout rules that are load bearing

- **The architecture page is full width.** `stage.full` switches off the
  two-column grid and lays the reasoning out in columns underneath instead, so
  the diagram gets the entire content area. The sweep asserts the diagram is
  over 1000px wide and that the two cards are not side by side.
- **The header is compact** (~52px, sticky) and carries the current topic
  number rather than a hero. An early version opened with a full-width hero
  repeated on every screen, which pushed the content below the fold.
- **The glossary opens first in the reference sheet**, ahead of the About text
  and the doc-drift notes, because a newcomer meets an unknown word before they
  want a preamble. The header button is labelled "Glossary" for the same reason.
- **Controls are scoped.** A topic that does not read a control dims it and
  labels it with the topic numbers that do, which are clickable.
- **The topic rail needs `min-w-0`.** A grid item defaults to
  `min-width: auto`, so it refuses to shrink below its content's intrinsic
  width. Below `lg` the rail lays out in a row, and without `min-w-0` on its
  `nav` its ~980px intrinsic width set the width of the whole page. The `ul`
  already carries `overflow-x-auto`, but that cannot engage until its parent
  is allowed to shrink.
- **The page carries exactly one `h1`**, the topic line in the header. Every
  topic title is an `h3` inside a `Card`, so without it the page has no
  heading outline at all. It is the text already in the header rather than a
  hero, for the reason above.

## House style for the prose

Four rules, and they are why the page reads the way it does:

1. **No em dashes.** Use a comma, a colon, a full stop, or brackets. The sweep
   fails if one reaches the rendered page.
2. **No insider vocabulary.** If a phrase sounds clever it is standing in for a
   plain sentence; write the plain sentence. "A second, weaker safeguard" rather
   than "belt and suspenders". "Worked out by subtraction" rather than "derived
   residually". "It fails only on cases that used to pass" rather than "the gate
   is a set difference".
3. **Say each thing once**, in the topic that owns it.
4. **Every topic ends with what it cannot do**, in the same amber block, and
   that block is never softer than the claim above it.

## Accuracy contract

Every number, model id, threshold, field name and file path was read out of this
repo, and each topic lists the files behind it. Sample dialogue is written for
the page and labelled as such. No real CV, job description, transcript, session
id or credential appears anywhere, which matters given that keeping exactly that
content out of exported telemetry is one of the things the page is about.

Where the page and the prose docs disagree it follows the code and says so, in
the reference sheet. Three live cases: the injection corpus holds **53** cases,
not the 54 in `ARCHITECTURE.md` §7/§11 and `run_audit.py`'s docstring, of which
52 are in the committed baseline; the cron reconciler sweeps **three** stale
classes, not the two described in `ARCHITECTURE.md` §6; and `persona.py` plus
`security_guards.py` still carry docstrings describing the superseded relay
design.

The page also surfaces one gap in the repo's own harness rather than hiding it:
`simulated_candidate.py` defines an interjection budget for all three
intensities, but `run_sim.py` only runs calm and grill, so `standard` is
implemented in the checker and never exercised by the gate.

## Changing it

There is no unit test for this page. It is verified by driving it with a
Playwright DOM sweep that checks all 11 topics render, the architecture page is
full width with five bands, its blocks navigate correctly, every control changes
downstream state, no em dash reaches the page, and no content is cut off at
390px.

The last one has to be measured carefully. `body` sets `overflow-x: hidden`, so
asking whether the *document* scrolls sideways answers the wrong question: an
overflowing page is clipped rather than scrolled and the check passes while
content sits unreachable off-screen. That is exactly how the `min-w-0` bug
above survived a sweep. Assert instead that `document.body.scrollWidth` is
within the viewport, and that every element wider than its own box carries
`overflow-x: auto` or `scroll` so its content can still be reached. `npx tsc --noEmit` and `npm run lint` cover the rest, since this page
is compiled and linted with everything else.

Nothing on this page executes an eval harness. It describes `eval/run.ts`, the
judge gate, `evals/run_sim.py` and `security/run_audit.py`; it never runs them,
and verifying the page costs no model tokens.
