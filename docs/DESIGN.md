---
name: driller
description: Developer tool for supervising AI-agent-written code via a map-first, hyperlinked code graph — not a generic analytics dashboard.
status: final
sources:
  - prd.md
updated: 2026-10-15
mode: dark-first
colors:
  bg: '#0a0f0d'
  panel: '#0e1613'
  panel-alt: '#0c1210'
  border: '#1e2b26'
  border-strong: '#2c3f37'
  # [ADDED 2026-09-26, P3-13] Founder decision: `border` (1.25:1) and
  # `border-strong` (1.64:1 against {colors.panel}) are decorative only. A
  # control whose edge is its only cue (text input, unfilled outlined button,
  # mode-switcher tab, pill affordance) takes `border-control` instead — the
  # dimmest step on the border-strong -> text-mute line that clears WCAG
  # 1.4.11's 3:1 against all three surfaces (3.16:1 bg, 3.01:1 panel, 3.10:1
  # panel-alt; computed, enforced by `contrast.test.ts`).
  border-control: '#50675c'
  text: '#cfe0d4'
  text-dim: '#7d9488'
  # Corrected during implementation review (2026-09-23, Blind Hunter finding,
  # verified): the original #4c5f55 computed to 2.69:1/2.83:1 against
  # {colors.panel}/{colors.bg} — well under WCAG AA's 4.5:1 normal-text
  # minimum, and a real regression versus the placeholder palette's
  # equivalent token (6.89:1). Lightened along the same hue to #6f8b7c
  # (4.95:1/5.21:1 against panel/bg — verified, not eyeballed), still
  # distinctly dimmer than `text-dim` (5.95:1) so the three-step text
  # hierarchy survives, just with real headroom above the AA floor instead
  # of under it.
  text-mute: '#6f8b7c'
  accent: '#39d98a'
  accent-dim: '#1f6b45'
  risk-amber: '#e8a33d'
  risk-red: '#ef5350'
  llm-violet: '#b48ce0'
  stale-yellow: '#d9c65a'
  trace-cyan: '#4fd8e0'
  # [ADDED 2026-10-15, P5-i] Founder decision 3.23: the shared-reach edge's
  # own stroke (P4-7h), a muted periwinkle apart from accent, trace-cyan and
  # the border greys of real edges and the ref connector. Computed 8.19 /
  # 7.79 / 8.03:1 against bg / panel / panel-alt; `contrast.test.ts` holds
  # it at >= 3:1 against bg (the canvas gutter it is drawn over).
  shared-reach-edge: '#9aa6e0'
  # Founder-confirmed via the Health Audit Mode mock request (2026-09-23),
  # not an assumption: both retired directions independently converged on a
  # green "healthy/low-risk" signal (dense-profiler's #4caf7d, modern-SaaS's
  # #35d68a) even though terminal-native's own source mockup never depicted
  # Health Audit Mode at all. Kept dimmer than `accent` and in the same cool
  # family so the two read as related-but-distinct, never confusable —
  # `accent` still means "changed" and only "changed."
  healthy: '#2f9e6e'
typography:
  code:
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 13px
    fontWeight: '600'
  body:
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 10.5px
    lineHeight: '1.45'
  ui:
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 11px
    lineHeight: '1.4'
  meta:
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 9.5px
    fontWeight: '700'
rounded:
  DEFAULT: 0px
  # The one deliberate exception — see Shapes. Badges only.
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '6': 24px
  gutter: 14px
  canvas-grid: 40px
components:
  node-card:
    background: '{colors.panel}'
    border: '1px solid {colors.border-strong}'
    radius: '{rounded.DEFAULT}'
    padding: '10px 11px 9px'
    # [ADDED 2026-10-15, P5-f] Founder decision 7.2: one long summary or
    # AI-judgment line made a card ~1000 px wide and pushed the next Revealed
    # column far right. Text wraps inside the cap (the summary keeps its
    # 2-line clamp; the identifier keeps its one-line ellipsis, its full name
    # in the accessible name); the signal strip and affordance row wrap.
    maxWidth: 320px
  node-card-changed:
    border: '1px solid {colors.accent}'
    ring: '0 0 0 1px {colors.accent}'
    prefix: '"● CHANGED" in {colors.accent}, never a color-only change'
  node-card-affected:
    border: '1px dashed {colors.accent-dim}'
  node-card-dim:
    opacity: 0.42
  # Added at this pass's review (2026-09-23, rubric walker, high finding),
  # then reconciled against the actual shipped app during implementation
  # planning (same day): the codebase already has a consistent, working
  # `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`
  # convention at ~13 locations (styles.css) — a real pattern the spine
  # simply hadn't caught up to, not a gap needing a new invented color. Kept
  # as `{colors.accent}`, not a dedicated new hue: it already reads as "the
  # one interactive/attention color" everywhere else (search prompt, active
  # tab), and since every existing rule references the shared CSS variable,
  # redefining `--accent` to this system's new green auto-updates every
  # focus ring — zero touch beyond the global token swap. Applies to any
  # focusable element (a Node, a mode-switcher tab, a table row, a form
  # control), always in addition to whatever state-color treatment that
  # element already carries — a focused, simultaneously-changed Node shows
  # both `node-card-changed` AND this ring, never one replacing the other.
  focus-ring:
    outline: '2px solid {colors.accent}'
    outline-offset: 2px
  # Modern-SaaS influence (founder-directed, 2026-09-23): pill-shaped, solid
  # fill, bold weight — the one place this system breaks its own "no rounded
  # corners" rule. Dense-profiler's badge-equivalent (`.mchip`) independently
  # converged on the same solid-fill-plus-dark-ink treatment, which is why
  # the ink values below are shared rather than badge-family-specific.
  badge:
    radius: '{rounded.full}'
    border: none
    padding: '3px 8px'
    fontSize: '{typography.meta.fontSize}'
    fontWeight: '700'
  # [CORRECTED 2026-09-26, P3-4] This token used to give all five
  # deterministic signal types one shared glyph ('◆'). That made complexity,
  # cognitive-complexity, hotspot, blast-radius and coverage-gap
  # indistinguishable by shape, breaking EXPERIENCE.md's Accessibility Floor.
  # The app was right and this file was wrong: each type has its own glyph
  # (`DETERMINISTIC_SIGNAL_ICONS`, CodeMap.tsx), listed below. The chip shows
  # glyph + number; the full signal name is in its aria-label.
  badge-risk-deterministic:
    background: '{colors.risk-amber}'
    color: '#241a04'
    glyphs:
      complexity: '●'
      cognitive-complexity: '■'
      hotspot: '▲'
      blast-radius: '◆'
      test-coverage-gap: '⊘'
  # [CORRECTED 2026-09-26, P3-4] Severe is not a sixth glyph. It is the same
  # chip with the red fill, plus a `!` placed BEFORE the type glyph
  # (`SEVERE_SIGNAL_GLYPH`, CodeMap.tsx, since P1-1) and "(severe)" appended
  # to the label. So a severe hotspot reads `! ▲ 14`: red is never the only
  # cue, and the type stays readable. `!` must differ from every type glyph.
  badge-risk-severe:
    background: '{colors.risk-red}'
    color: '#2a0a0a'
    glyph-prefix: '!'
    label-suffix: '(severe)'
  # [CORRECTED 2026-09-26, P3-4] Not a pill. This family carries a sentence,
  # not a number, and a sentence can't sit in a 9.5px pill. The app renders
  # it as a block callout: a 1px dashed {colors.llm-violet} border, square
  # corners, a transparent background, and italic {colors.llm-violet} text led
  # by "AI judgment:" (`.code-map__llm-judgment`, styles.css). The violet and
  # italic below still apply, as border/text colour rather than a fill.
  badge-llm-judgment:
    background: '{colors.llm-violet}'
    color: '#241635'
    fontStyle: italic
    glyph: '✦'
    rendered-as: 'block callout, 1px dashed {colors.llm-violet} border, radius 0, transparent background, violet italic text'
  # [CORRECTED 2026-09-26, P3-4] Not a pill either. It is one row per finding
  # (severity as visible text, source tool, finding text), capped with a
  # "+N more" line, inside a list block with a 1px solid {colors.risk-amber}
  # border, square corners and a transparent background
  # (`.code-map__ingested-findings`, styles.css). Pill-ising it would push
  # toward the "wall of inline comments" EXPERIENCE.md forbids. The shipped
  # row glyph is '⚑' (CodeMap.tsx), not the '▤' below; which one is
  # canonical is still a founder call, so both are recorded here.
  badge-ingested-finding:
    background: '{colors.risk-amber}'
    color: '#241a04'
    glyph: '▤'
    shipped-glyph: '⚑'
    rendered-as: 'list block, 1px solid {colors.risk-amber} border, radius 0, transparent background, one row per finding'
  badge-stale:
    background: '{colors.stale-yellow}'
    color: '#241f04'
    glyph: '⏱'
  mode-switcher-tab:
    fontSize: '{typography.ui.fontSize}'
    color: '{colors.text-mute}'
    padding: '9px 18px'
    border: '1px solid {colors.border-control}'
  mode-switcher-tab-active:
    color: '{colors.bg}'
    background: '{colors.accent}'
    fontWeight: '600'
  # [ADDED 2026-09-30, P4-4] The Section bar (EXPERIENCE.md § Component
  # Patterns, "Section bar"): a tab row under the header, deliberately quieter
  # than the mode switcher — meta-size text, no border, no fill. Text-only
  # tabs have no edge that is their only cue, so `border-control` does not
  # apply. The active tab is an underline in {colors.text} plus
  # `aria-selected`, never colour alone and never {colors.accent}: accent
  # means "changed" (plus keyboard focus and the active mode-switcher tab),
  # and a section is none of those. Keyboard focus still takes
  # {components.focus-ring}. Computed: `text-mute` 5.21 / 4.95 / 5.10:1 and
  # `text` 14.04 / 13.36 / 13.76:1 against bg / panel / panel-alt.
  section-tab:
    fontSize: '{typography.meta.fontSize}'
    color: '{colors.text-mute}'
    # [UPDATED 2026-10-15, P5-g] Founder decision 2.3: was '4px 10px', a
    # ~21px tab at 9.5px text — under WCAG 2.5.8's 24px target size. 6px
    # vertical padding makes it ~25px; font, colour, border and the active
    # underline are unchanged.
    padding: '6px 10px'
    border: none
  section-tab-active:
    color: '{colors.text}'
    borderBottom: '2px solid {colors.text}'
    fontWeight: '600'
  path-trace-search:
    prompt: '"trace>" in {colors.accent}'
    input-color: '{colors.text-mute}'
    cursor: '7px x 13px block, {colors.accent}, 1.1s step blink'
  path-trace-route:
    stroke: '{colors.trace-cyan}'
    strokeWidth: 2px
    hop-pill-background: '{colors.trace-cyan}'
    hop-pill-color: '#04211f'
  # Dense-profiler influence (founder-directed, 2026-09-23): the Path Trace
  # step list's resolved visual is dense-profiler's indented call-stack
  # treatment (hop circle, tree-indent glyph, identifier, module), restyled into
  # this system's own tokens — not terminal-native's small-node-card list.
  # One field of the source pattern is deliberately dropped: dense-profiler
  # shows a per-hop duration estimate ("2.1ms"), which assumes runtime
  # profiling data driller doesn't have (it resolves paths statically from
  # the call graph, never executes anything) — inventing a number here would
  # be exactly the "silent fabricated data" driller's own trust model exists
  # to prevent, so this component has no duration field at all.
  path-trace-stack-row:
    background: '{colors.panel}'
    border-bottom: '1px solid {colors.border}'
    hop-circle-background: '{colors.trace-cyan}'
    hop-circle-color: '#04211f'
    indent-glyph: '└─, {colors.text-mute}'
    name-color: '{colors.text}'
    module-color: '{colors.text-mute}'
  coverage-gap-indicator:
    color: '{colors.risk-red}'
    background: 'rgba(239,83,80,.08)'
    glyph: '◆'
    note: 'distinct glyph/position from Staleness Indicator — never the same treatment'
  staleness-indicator:
    color: '{colors.stale-yellow}'
    glyph: '⏱'
    note: 'distinct glyph/position from Coverage Gap — never the same treatment'
  actionable-notice:
    borderLeft: '2px solid {colors.accent}'
    background: '{colors.panel-alt}'
    padding: '10px 16px'
    titleColor: '{colors.text}'
    bodyColor: '{colors.text-dim}'
  canvas:
    background: '{colors.bg}'
    grid: '{colors.border} 1px lines, {spacing.canvas-grid} cell'
  # Modern-SaaS influence (founder-directed, 2026-09-23): cubic-bezier curved
  # connectors instead of terminal-native's straight segments — read more
  # legible once nodes aren't positioned in a strict line — plus a second,
  # accent-colored stroke variant for edges leading out of a changed/traced
  # Node, so directional flow from the point of change is visible on the
  # edge itself, not just the endpoints.
  canvas-edge:
    stroke: '{colors.border-control}'
    strokeWidth: 1.5px
    path: cubic-bezier, matches modern-saas mockup's control-point ratio
    # [ADDED 2026-10-15, P5-f] Founder decision 7.1: applies to the edge's
    # VISIBLE path (React Flow's `.react-flow__edge-path`), not its group —
    # on the group it never painted, and plain edges showed React Flow's
    # #3e3e3e at 1px. Measured: border-strong on bg is 1.72:1 (#3e3e3e was
    # 1.81:1); decorative, not a control's only cue, so 3:1 is not required.
    # If edges read too faint on a dense map, border-control (>= 3:1) is the
    # Ask First alternative.
    # [CHANGED 2026-10-25] Taken: that alternative, on the founder's say-so
    # after driller was dogfooded on its own repository. The live judgement
    # P5-f deferred came back negative — across 34 cards and 59 edges the
    # strokes cannot be followed, and crossings are unreadable. The premise
    # that they are decorative no longer holds either: the grouped Full map
    # carries every relation it shows in these edges and nothing else, which
    # is WCAG 1.4.11's 3:1 for a meaningful graphical object. border-control
    # is 3.16:1 on bg, and contrast.test.ts enforces the rule rather than
    # recording its ratio.
    note: 'stroke and width apply to the visible path; highlight, path-trace and shared-reach strokes override it on that same path'
  canvas-edge-highlighted:
    stroke: '{colors.accent}'
    strokeWidth: 2px
    note: 'edges leading out of a changed Node in PR Review Mode; Path Trace routes use {components.path-trace-route} instead'
  # [ADDED 2026-10-15, P5-i] Founder decision 3.23 (built in P4-7h): the
  # Revealed view's shared-reach arc between two entry candidates. A derived
  # fact (both reach N common Nodes in indexed code), never a call: its own
  # token and a round-dotted stroke, apart from the ref connector's dashes
  # and every real edge. Drawn only for the hovered or keyboard-focused
  # candidate, to at most its 3 strongest partners, as an arc through the
  # gutter left of column 0. Not selectable, focusable or clickable.
  reveal-shared-reach-edge:
    stroke: '{colors.shared-reach-edge}'
    strokeWidth: 1.5px
    strokeDasharray: '0.5 4'
    strokeLinecap: round
    opacity: 0.85
    label: '"shares N" in {colors.text}, 10px, on {colors.panel}'
    note: 'the label carries the meaning, never the colour alone; legend glyph "···" in the same token'
  # Modern-SaaS influence (founder-directed, 2026-09-23): the explicit
  # relative-time recency line in the footer ("Last synced 2 min ago" / PR
  # Review; "Last full scan 14 min ago" / Health Audit). The content pattern
  # is modern-SaaS's; the rendering is this system's own plain footer text
  # (modern-SaaS's own version is unstyled footer text too — no bespoke
  # treatment to carry over beyond the pattern itself).
  sync-status:
    color: '{colors.text-mute}'
    fontSize: '{typography.ui.fontSize}'
    position: 'footer, right-aligned'
  # Dense-profiler influence (founder-directed, 2026-09-23): PR Review
  # Mode's metrics section — the canvas stays purely structural/spatial on
  # one side, every changed/affected Node's complexity, coverage gap, blast
  # radius, and findings live in a sortable table on the other, complexity
  # and blast radius each paired with a small inline bar (P4-3d, Decision 3:
  # bars on those two columns only). Restyled sharp/flat/mono
  # rather than dense-profiler's own rounded-neutral register. New surface —
  # see EXPERIENCE.md § Component Patterns, "PR Review metrics table".
  # [UPDATED 2026-09-30, P4-3d — Decision 3] Bars are coloured only from the
  # signal's own `severity`, which has two tiers: `severe`, and `moderate`
  # (meaning only "not severe"). So a bar is neutral (`bar-fill-moderate`,
  # `{colors.text-dim}`) or severe (`bar-fill-severe`); `bar-fill-low` is
  # dropped — no green or "low" band is invented. A bar's length is relative
  # to its column's maximum in this table (the header says so), and its text
  # value and the severe `!` glyph always stay beside it.
  pr-review-metrics-table:
    background: '{colors.panel}'
    header-background: '{colors.panel-alt}'
    header-color: '{colors.text-mute}'
    row-alt-background: '{colors.panel-alt}'
    row-changed-background: 'rgba(57,217,138,.08)'
    row-changed-rule: '2px solid {colors.accent}'
    bar-track: '{colors.border}'
    bar-fill-moderate: '{colors.text-dim}'
    bar-fill-severe: '{colors.risk-red}'
    cell-color: '{colors.text}'
    cell-mono: '{typography.code.fontFamily}'
  # Health Audit Mode's own resolved layout — see EXPERIENCE.md. Structure
  # (cluster grouping, heat labels) sourced from modern-SaaS's Health Audit
  # secondary state, the only one of the three source mockups to depict this
  # surface at all; restyled sharp/flat/mono, no gradient card backgrounds.
  health-cluster-card:
    background: '{colors.panel}'
    border: '1px solid {colors.border-strong}'
    radius: '{rounded.DEFAULT}'
    heat-dot-hot: '{colors.risk-red}'
    heat-dot-warm: '{colors.risk-amber}'
    heat-dot-cool: '{colors.healthy}'
    # [UPDATED 2026-09-24, P0-2a] The grouping helper bands heat into FOUR
    # states, because the shipped `riskCountBucket` it reuses has four
    # outcomes. They map onto these three tokens, no fourth token needed:
    #   hot     (6+ signals on some Node) -> heat-dot-hot
    #   warm    (3-5)                     -> heat-dot-warm
    #   cool    (1-2)                     -> heat-dot-cool
    #   healthy (0 — nothing at all)      -> heat-dot-cool
    # `cool` and `healthy` deliberately share a dot: `heat-dot-cool` already
    # resolves to `{colors.healthy}`, and the two are told apart by the count
    # the label must always state beside the dot ("cool · 2 signals" vs.
    # "healthy · 0 signals"), never by color. Four bands exist rather than
    # three so a clean repo's card is ordinary output carrying an explicit
    # `healthy`, not a null/absent heat (AD-13's explicit-result-state
    # pattern).
    heat-band-to-dot: 'hot -> heat-dot-hot; warm -> heat-dot-warm; cool, healthy -> heat-dot-cool'
    row-border: '1px solid {colors.border}'
    row-label-color: '{colors.text}'
    row-value-color: 'matches its own heat-dot color'
    # [UPDATED 2026-09-24, P0-2c] A row is a CONTROL, not a read-out:
    # activating it opens Node detail for that Node (EXPERIENCE.md's
    # "Health Audit cluster card" row). It therefore needs a control's
    # three states, and this is where they are defined — the interaction
    # had been living only in the stylesheet.
    #
    # Nothing here overrides `row-value-color`: the heat colouring sits
    # INSIDE the row control and is untouched by all three states, which is
    # why the focus treatment is the shared outline rather than a border or
    # an inset shadow that would have to share space with it.
    row-cursor: 'pointer'
    row-hover-background: 'color-mix({colors.accent} 15%, transparent)'
    row-focus: '{components.focus-ring}, drawn inset (outline-offset: -2px)'
    # Inset because rows stack flush, separated only by `row-border`: a ring
    # at the token's own positive offset would overlap that divider and the
    # neighbouring rows, reading as two focused rows.
    #
    # The capped remainder lines ("+N more Nodes"/"+N more modules") get NONE
    # of these. They are counts of what the display caps dropped, not Nodes,
    # so there is nothing for them to open and they must not look activatable.
---

# driller — Design Spine

> Synthesis resolved 2026-09-23 (see `.memlog.md`) — terminal-native is the dominant, settled visual base across every token in this file, with three specific, founder-directed elements layered in from the two retired directions (see each component's own comment above): modern-SaaS's badge treatment, connecting-line styling, and Health Audit Mode cluster layout; dense-profiler's Path Trace stack view and PR Review metrics table. Nothing below is deferred.

## Brand & Style

Code-first, not dashboard-first: driller must never read as a BI/analytics tool with a graph bolted on. Four visual directions were explored against the Code Map hero screen (terminal-native, blueprint/engineering-schematic, modern-SaaS, dense-profiler); blueprint was rejected outright. Of the three survivors, **terminal-native is the resolved, dominant base for the whole system**: sharp corners everywhere except badges, monospace for every piece of text (not just code identifiers), a dot-grid canvas like a schematic notebook, and chrome borrowed straight from a terminal multiplexer (a titlebar with a repo path and branch, a tmux-style tab bar for the mode switcher, a status line). It reads as "a tool you `open` next to a shell," not a product.

Three specific elements are deliberately layered in from the two retired directions — each because it solves a real gap terminal-native's own source mockup left open, not as aesthetic preference:

- **From modern-SaaS** — badge styling (pill-shaped, solid-fill, the one break from this system's own sharp-corner rule), connecting-line styling (curved, with an accent-colored variant for edges leaving a changed Node), and the Health Audit Mode cluster-card layout (the only one of the three source mockups to depict this surface at all).
- **From dense-profiler** — the Path Trace step list's resolved visual (an indented call-stack view, not a node-card list), and PR Review Mode's metrics table (canvas stays structural, every changed/affected Node's signals live in a sortable table alongside it).

Everything else in this system is terminal-native's, unmodified in register even where re-themed with this system's own tokens.

Canonical mockup: `mockups/direction-terminal-native.html`. Full mockup-to-surface mapping, retired-direction provenance, and the conflict-resolution rule: see EXPERIENCE.md § Information Architecture — the single source of truth for that list, kept in one place to avoid drift.

## Colors

`{mode}`: dark-first, confirmed (developer tool, graph visualization, long review sessions, better contrast headroom for Risk Overlay signal coloring). Light mode remains a secondary target, derived from this palette rather than designed in parallel — no light-mode token set exists yet; treat this as an open follow-up, not a silent gap.

- **`{colors.bg}` / `{colors.panel}` / `{colors.panel-alt}`** — a near-black, faintly green-cast three-step surface stack. `bg` is the page/canvas; `panel` is every Node card, frame, and table; `panel-alt` is chrome (titlebar, tab bar, status line, search row, table header/zebra rows).
- **`{colors.border}` / `{colors.border-strong}`** — decorative hairlines only; `border-strong` marks a Node's own edge and frame edges, `border` marks structural chrome dividers, table row rules and cards that already sit on a background step.
- **`{colors.border-control}`** — `[ADDED 2026-09-26, P3-13]` the control-boundary token. **Rule:** any boundary that is a control's only visual cue — text inputs, outlined buttons with no fill, mode-switcher tabs, the Node card's pill affordances, the Recent Projects buttons (whose `panel` fill is only a 1.05:1 step off `bg`) — uses `border-control`, which measures ≥ 3:1 (WCAG 1.4.11) against `bg`, `panel` and `panel-alt`. `border`/`border-strong` never edge a control whose edge is its only cue (cards that already sit on a background step — Node, cluster and health cards, panel frames — keep their decorative edge). Hover/active states may go brighter (`accent`, `text-mute`), never dimmer. Native checkboxes and radios keep the platform's own edge, measured in a headless-Chrome render of the real stylesheet (Chrome 153, dark `color-scheme`, 2x):
  - unchecked checkbox and radio: edge `#858585` — 5.24:1 on `bg`, 4.98:1 on `panel`, 5.13:1 on `panel-alt` (at 1x the anti-aliased radio ring softens to about `#6f6f6f`, 3.70–3.84:1);
  - checked checkbox fill and radio ring (`accent-color: {colors.accent}`): `#39d98a` — 10.55 / 10.03 / 10.33:1;
  - mode-switcher radio: unchecked `#858585`, 5.13:1 on `panel-alt`; checked, it sits on the active tab's `accent` fill, so it takes `accent-color: {colors.bg}` — a `#0a0f0d` ring, 10.55:1 against the fill (Chromium's default system-blue ring measured 1.07:1 there).
- **`{colors.text}` / `{colors.text-dim}` / `{colors.text-mute}`** — a three-step text hierarchy: `text` for a Node's own identifier, `text-dim` for summaries and module paths, `text-mute` for placeholders, hints, inactive chrome, and sync-status text.
- **`{colors.accent}`** — bright terminal green. Means **changed**: a changed Node's border and prefix, the Path Trace prompt, the blinking cursor, an active mode-switcher tab, an outbound edge from a changed Node, a changed row's rule in the PR Review metrics table. Also doubles as the keyboard-focus ring (`{components.focus-ring}`) — a pre-existing codebase convention (`:focus-visible`, ~13 sites), not a new use invented here; the two meanings ("this changed" / "this has keyboard focus") don't collide in practice since focus is transient and changed is persistent, and the ring is additive on top of whatever else a Node shows. Never used decoratively beyond these two. `[ADDED 2026-09-30, P4-4]` The Section bar's active tab does **not** use accent: a section is not a change, so it takes an underline in `{colors.text}` instead (`{components.section-tab-active}`); only its keyboard focus ring is accent.
- **`{colors.accent-dim}`** — the same hue, desaturated. Means exactly one thing: **affected** — the dashed ring on a Node inside a changed Node's blast radius.
- **`{colors.risk-amber}` / `{colors.risk-red}`** — measured, deterministic risk overlay signals. Amber for moderate, red for severe — always paired with a distinct glyph and label text, never color-alone.
- **`{colors.llm-violet}`** — the LLM-judgment signal family (FR-8), always paired with italic text and its own glyph (`✦`).
- **`{colors.stale-yellow}`** — the Staleness Indicator (FR-16) exclusively.
- **`{colors.trace-cyan}`** — Path Trace's own route highlight and stack-row hop circles (FR-10), exclusively.
- **`{colors.shared-reach-edge}`** — `[ADDED 2026-10-15, P5-i]` the Revealed view's shared-reach arc between two entry candidates and its legend glyph, exclusively. It shows **derived reach, never a call**: two candidates both reach N Nodes in indexed code. Its "shares N" label carries the meaning, never the colour alone (`{components.reveal-shared-reach-edge}`).
- **`{colors.healthy}`** — Health Audit Mode's positive/low-risk signal: a "cool" cluster's heat dot. `[UPDATED 2026-09-30, P4-3d]` No longer a PR Review metrics-table bar fill: that table's bars are neutral or severe only (Decision 3). The one color in this palette confirmed by convergence across two independent source directions rather than by terminal-native's own (Health-Audit-silent) mockup.

## Typography

One font family, everywhere, without exception: `{typography.code.fontFamily}` (a system mono stack) — settled before this pass and now extended system-wide (chrome, tables, everything), not just code identifiers.

Four roles, one family, differentiated by size/weight only:

- **`{typography.code}`** (13px, 600 weight) — a Node's own identifier; a metrics-table cell's node name.
- **`{typography.body}`** (10.5px, 1.45 line-height) — a Node's one-line AI summary, Actionable Notice body copy.
- **`{typography.ui}`** (11px) — chrome: tab labels, titlebar, status line, footer, search input, sync-status, table headers.
- **`{typography.meta}`** (9.5px, 700 weight) — module path lines, badge label text.

No serif, no secondary display face, no variable sizing beyond this four-step ramp.

## Layout & Spacing

Scale: `{spacing.1}`–`{spacing.6}` (4/8/12/16/24px), plus `{spacing.canvas-grid}` (40px, the dot-grid cell size) and `{spacing.gutter}` (14px, standard chrome-row horizontal padding).

Single-surface desktop app (Electron, no responsive/multi-platform concern — see EXPERIENCE.md § Foundation). Two layouts now exist beyond the single-canvas default: PR Review Mode's canvas-plus-metrics-table split (dense-profiler-sourced) and Health Audit Mode's cluster-card grid (modern-SaaS-sourced) — both are fixed two-region layouts that don't reflow responsively, consistent with the single-surface, single-window target.

## Elevation & Depth

Deliberately flat. No card elevation, no soft shadow, no glow, no blur — depth is communicated by the three-step surface-color stack and 1px borders alone. The one exception is the outer app frame's hard drop shadow, purely to separate it from the OS window behind it — never used on any element inside it, including the new metrics table and cluster cards (which stay flat, unlike modern-SaaS's own elevated cluster-card treatment).

## Shapes

`{rounded.DEFAULT}`: `0px`, system-wide — no card, table, input, or cluster card carries any corner radius. **One deliberate, named exception: `{rounded.full}` (9999px) on badges only** — pill-shaped, solid-fill, the one place this system borrows modern-SaaS's register rather than terminal-native's own square-badge treatment. This exception is intentional and load-bearing, not a lapse: it's the single visual cue that a badge is a *distinct, interactive-feeling* signal chip rather than another flat panel edge.

## Components

- **Node** → `{components.node-card}`, with state modifiers `{components.node-card-changed}`, `{components.node-card-affected}` (inside a changed Node's blast radius — dashed `{colors.accent-dim}` ring), `{components.node-card-dim}` (outside the current scope of interest — present but visually receded, opacity only, never hidden). All three are independent of, and layer beneath, `{components.focus-ring}` when the element also has keyboard focus. See `mockups/node-detail.html` for the expanded Node detail composition (summary, signal strip, staleness, coverage-gap note, source action).
- **Focus** → `{components.focus-ring}`, on any focusable element (Node, mode-switcher tab, table row, form control) per EXPERIENCE.md § Accessibility Floor / § State Patterns "Focus" row. Already implemented in the shipped app (`:focus-visible` at ~13 sites) — this pass's own review just caught that the spine hadn't documented it yet; see `{components.focus-ring}`'s own comment for the reconciliation.
- **Signal strip / badges** → `[CORRECTED 2026-09-26, P3-4]` The `{components.badge}` pill shell (solid fill, full radius) is used where the content is a glyph plus a short value. On a Node, that means the deterministic signal chips only. A pill everywhere was wrong for families that carry prose. In practice:
  - **Deterministic (moderate):** amber pill, one glyph per signal type — complexity `●`, cognitive-complexity `■`, hotspot `▲`, blast-radius `◆`, test-coverage-gap `⊘` — followed by the number. The full name is in the chip's `aria-label`. See `{components.badge-risk-deterministic}`.
  - **Deterministic (severe):** the same pill in red, with `!` before the type glyph (e.g. `! ▲ 14`) and "(severe)" appended to the label. See `{components.badge-risk-severe}`.
  - **LLM judgment:** a dashed violet block callout with the `✦` glyph and a full sentence led by "AI judgment:" — not a pill. See `{components.badge-llm-judgment}`.
  - **Ingested findings:** an amber-bordered list block, one row per finding (severity as text, source tool, finding), capped with "+N more" — not a pill. See `{components.badge-ingested-finding}`.
  - **Stale:** the Staleness Indicator renders as its own always-visible text line, not a pill (see `{components.staleness-indicator}`).
  - **Other pills:** the pill shell is also used by non-signal status badges (the header index-state `.badge` and the Node's "changed" badge).

  Every family, pill or block, pairs its color with both a distinct glyph and label text. Contrast target: 4.5:1 minimum (WCAG AA, normal text — badges are 9.5px, well under the large-text carve-out), computed per fill/ink pair (standard relative-luminance formula, not eyeballed) after this pass's review (2026-09-23): `badge-risk-deterministic`/`badge-ingested-finding` 7.95:1, `badge-risk-severe` 5.25:1, `badge-llm-judgment` 6.26:1, `badge-stale` 9.57:1 — all pass. The same review round also computed ratios for the two fill/white-ink pairs the new dark-ink values replaced: they failed at ~2.7:1/~3.49:1. Every badge ink is now dark, none white, for exactly this reason.
- **Staleness Indicator** → `{components.staleness-indicator}`.
- **Coverage Gap** → `{components.coverage-gap-indicator}`.
- **Mode switcher** → `{components.mode-switcher-tab}` / `{components.mode-switcher-tab-active}`.
- **Section bar** → `[ADDED 2026-09-30, P4-4]` `{components.section-tab}` / `{components.section-tab-active}`. A tmux-style tab row under the header, shown only when the indexing-scope allowlist has 2 or more entries, and deliberately quieter than the Mode switcher (`{typography.meta}` size, `{colors.text-mute}`, no border, no fill). The active tab is an underline in `{colors.text}` plus `aria-selected` — never colour alone, and never `{colors.accent}` (see § Colors). Keyboard focus still takes `{components.focus-ring}`. Behaviour: EXPERIENCE.md § Component Patterns, "Section bar".
- **Path Trace result** → `{components.path-trace-search}` for the persistent search affordance; `{components.path-trace-route}` for the on-map highlighted route; **`{components.path-trace-stack-row}` for the ordered step list** — dense-profiler's indented call-stack visual (hop circle, tree-indent glyph, identifier, module), no duration field (see that token's own comment).
- **PR Review metrics table** → `{components.pr-review-metrics-table}`. New named component (this pass) — see EXPERIENCE.md § Component Patterns for its behavioral spec. Canvas stays purely structural; every changed/affected Node's complexity, Coverage Gap, Blast Radius, and findings render together as one row, with an inline bar beside complexity and Blast Radius only (`[UPDATED 2026-09-30, P4-3d]` Decision 3). Columns really sort (header buttons with `aria-sort`), and rows are zebra-striped, with a changed Node's row rule-highlighted.
- **Health Audit cluster card** → `{components.health-cluster-card}`. New named component (this pass) — see EXPERIENCE.md § Component Patterns. Nodes are grouped by their containing directory; each group carries one heat dot and lists its own Nodes with their real signal values. `[UPDATED 2026-09-24, P0-2a]` Heat is banded from risk-signal COUNT, never severity (no risk-signal contract carries a severity field), into four states — `hot`/`warm`/`cool`/`healthy` — rendered through the three existing dot tokens per `{components.health-cluster-card}`'s own `heat-band-to-dot` mapping: `cool` and `healthy` share `heat-dot-cool`, and are distinguished by the count stated beside the dot, never by color. See `mockups/health-audit-mode.html` for the resolved composition — but not for its `61% gap`/`74% gap` values, which depict data driller cannot produce. `[UPDATED 2026-09-24, P0-2c]` A Node's row is an activatable control that opens Node detail — see `{components.health-cluster-card}`'s own `row-cursor`/`row-hover-background`/`row-focus` fields, which layer `{components.focus-ring}` (inset) over the row's heat colouring rather than replacing it. The capped "+N more" remainder lines stay inert.
- **Sync status** → `{components.sync-status}`. New named, minor component (this pass) — plain footer text stating recency ("Last synced N ago" / "Last full scan N ago").
- **Canvas edges** → `{components.canvas-edge}` (default), `{components.canvas-edge-highlighted}` (leaving a changed Node).
- **Revealed shared-reach arc** → `[ADDED 2026-10-15, P5-i]` `{components.reveal-shared-reach-edge}`: the dotted "shares N" arc between the hovered or focused candidate and up to 3 partners, plus its line in the Revealed legend. Revealed itself: EXPERIENCE.md § State Patterns, "Revealed"; the arc's routing and drawing rules: `spec-p4-7h-candidate-shared-reach.md`.
- **Actionable Notice** → `{components.actionable-notice}`.
- **Backend config control / External editor control** — standard Settings-surface form controls (radio groups, text input), no bespoke treatment beyond this system's base tokens; see `mockups/settings.html` (this pass) for the resolved composition.
- **Canvas** → `{components.canvas}` (background/grid) plus the edge tokens above.

## Do's and Don'ts

- **Don't** let the Code Map read as a BI/analytics dashboard — no stat tiles, no marketing-style data-viz flourishes divorced from the actual code structure.
- **Don't** use the blueprint/engineering-schematic register (rejected) or reintroduce its literal-schematic motifs into the system.
- **Don't** round any corner anywhere, **except badges** (the one named, deliberate exception — see Shapes).
- **Don't** distinguish Risk Overlay signal families, Staleness, or Coverage Gap by color alone — every one pairs a color with a distinct glyph and label text.
- **Don't** add elevation, glow, blur, or motion beyond the Path Trace prompt's single blinking cursor.
- **Don't** show a duration/timing figure anywhere (Path Trace stack rows or elsewhere) — driller resolves paths statically and never executes code; a duration number would be fabricated data.
- **Do** keep every piece of text — not just code identifiers — in `{typography.code.fontFamily}`, everywhere, without exception.
- **Do** treat dark mode as the primary and only currently-designed target; light mode is a deferred, derived follow-up.
- **Do** treat `{colors.accent}` as meaning "changed" (or, additively, keyboard focus — see § Colors) and nothing else.
- **Do** keep the PR Review metrics table and Health Audit cluster cards flat and sharp-cornered even though their structural inspiration (dense-profiler, modern-SaaS) wasn't — the layout/IA is borrowed, the register is not.
- **Do** apply `{components.focus-ring}` to any focusable element on keyboard focus, layered on top of (never replacing) whatever state treatment that element already carries.
