# driller docs

driller is a local-first Electron desktop app that gives a software engineer a browsable, AI-summarized, risk-annotated Code Map of a codebase — the first screen opened when reviewing an AI agent's change, instead of a diff or file tree.

This folder is the in-repo, git-tracked source of truth for what driller is and how it's built. It's meant to stay current as the project evolves — when a requirement or architecture decision changes, the corresponding doc here is updated in the same change, not left to drift. The original founder-authored planning corpus this was distilled from (product brief, full PRD, architecture spine, UX design/experience spines, epics and stories) lives outside this git repo, under `_bmad-output/` at the project root, and is preserved there as historical record rather than duplicated here.

## Documents

- **[prd.md](prd.md)** — Product Requirements. What driller is for, who it's for, the functional and non-functional requirements, explicit non-goals, MVP scope, and success metrics. Read this to understand *what* is being built and *why*.
- **[arc42.md](arc42.md)** — Architecture, in the [arc42](https://arc42.org) format. Constraints, system context, the hexagonal ports-and-adapters strategy, building blocks, runtime and deployment views, crosscutting concepts, the full architecture decision log, and known risks. Read this to understand *how* it's built.
- **[agent.md](agent.md)** — A short, enforceable checklist of invariants for anyone (AI agent or human) writing code here, plus a repo layout quick-reference and current build status. Read this before making a change.

## How these relate

`prd.md` and `arc42.md` are each other's counterpart — requirements and the architecture built to satisfy them — and cross-reference by FR/AD ID rather than repeating each other's content. `agent.md` doesn't introduce new information; it's a condensed, action-oriented view over rules that are fully explained in `arc42.md`.

For day-to-day implementation tracking (epics, stories, sprint status) rather than durable product/architecture decisions, see `_bmad-output/implementation-artifacts/sprint-status.yaml` and the story files alongside it.
