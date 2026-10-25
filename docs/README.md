# driller docs

driller is a local-first Electron desktop app that gives a software engineer a browsable, AI-summarized, risk-annotated Code Map of a codebase — the first screen opened when reviewing an AI agent's change, instead of a diff or file tree.

This folder is the in-repo, git-tracked source of truth for what driller is and how it's built. It's meant to stay current as the project evolves — when a requirement or architecture decision changes, the corresponding doc here is updated in the same change, not left to drift. The founder-authored planning corpus these docs were distilled from in September 2026 (product brief, full PRD, architecture spine, UX spines, epics and stories) no longer exists; everything it established was folded into the files below, so there is no older record to consult behind them.

## Documents

- **[prd.md](prd.md)** — Product Requirements. What driller is for, who it's for, the functional and non-functional requirements, explicit non-goals, MVP scope, and success metrics. Read this to understand *what* is being built and *why*.
- **[arc42.md](arc42.md)** — Architecture, in the [arc42](https://arc42.org) format. Constraints, system context, the hexagonal ports-and-adapters strategy, building blocks, runtime and deployment views, crosscutting concepts, the full architecture decision log, and known risks. Read this to understand *how* it's built.
- **[agent.md](agent.md)** — A short, enforceable checklist of invariants for anyone (AI agent or human) writing code here, plus a repo layout quick-reference. Read this before making a change.
- **[status.md](status.md)** — What is actually built, what is open, and what has only been claimed rather than verified, each row with the date of its evidence. Read this before assuming a capability behaves as the other docs describe.
- **[fork-enterprise-backlog.md](fork-enterprise-backlog.md)** — Capabilities requested for a planned **enterprise fork** of driller: a separate repository, forked from this one. Not driller's backlog and not a commitment for this repo; it is here only until the fork has somewhere of its own to keep it.
- **[DESIGN.md](DESIGN.md)** and **[EXPERIENCE.md](EXPERIENCE.md)** — The visual system (tokens, palette, type) and the interaction/journey spine. The behavioral and visual detail prd.md §6 deliberately leaves out.

## How these relate

`prd.md` and `arc42.md` are each other's counterpart — requirements and the architecture built to satisfy them — and cross-reference by FR/AD ID rather than repeating each other's content. `agent.md` doesn't introduce new information; it's a condensed, action-oriented view over rules that are fully explained in `arc42.md`.

`status.md` is the counterpart to all of them: those three say what driller should be, and it says how far the code has actually got, so a stale status claim never has to be guessed at from a requirement. Per-change detail below that level lives in the git history — commit messages here carry their own evidence and verification notes — not in a separate tracker.
