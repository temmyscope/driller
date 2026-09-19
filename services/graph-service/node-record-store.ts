/**
 * Node record store (Story 1.5 Phase 1, AD-19, AD-20).
 *
 * driller's first persistent local store: one JSON file per project under
 * `<userData>/node-records/<project-slug>.json`, keyed by content-stable
 * Node ID (AD-19 — the same `qualified_name`-derived `id` already used by
 * `CodeMapNode.id`, never a line number or array index).
 *
 * `NodeRecord` is intentionally extensible per future signal family — this
 * phase defines `summary` (Story 1.5 Phase 2's job to actually write) and
 * `llmJudgment` (Story 2.2 Phase 1 adds the field/shape; Phase 2 is the job
 * that actually writes it — this phase writes/reads neither), but the write
 * model below already treats every top-level key as an independently-
 * mergeable signal family per AD-20: `mergeNodeRecord` only ever shallow-
 * merges the top-level keys present in `partial` into the existing record,
 * so a write to one family (e.g. `llmJudgment` or a future `hotspot` field)
 * never touches another (e.g. `summary`), and a structural re-index — which
 * never calls this module with anything but fields it owns — can never
 * clear a previously-written one.
 *
 * This module runs inside the Graph Service subprocess (AD-18's process
 * boundary), which has no runtime access to Electron's `app` module (only
 * `process.parentPort` is real here — see index.ts's module doc) — so the
 * persistence root is handed in explicitly via `initNodeRecordStore`, using
 * `app.getPath('userData')` resolved on the main-process side and passed as
 * this subprocess's first fork argument.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IngestedRiskSignal } from '@driller/ipc-contracts';

/**
 * One Node's accumulated signals, keyed by content-stable Node ID (AD-19).
 * Every top-level field is its own signal family (AD-20) — extend this
 * shape with new optional fields as future stories add signal families
 * (hotspot history, LLM-judgment, ingested findings, …), never by changing
 * `summary`'s own shape to carry unrelated data.
 */
export interface NodeRecord {
  summary?: {
    text: string;
    model: string;
    generatedAt: string;
    // Story 1.8 Phase 1: an optional staleness baseline captured at
    // generation time (`summary-generator.ts`'s `captureSourceBaseline`) —
    // the real on-disk mtime/size of the Node's source file plus a SHA-256
    // of the exact summarized source range. Nested inside `summary` itself
    // (not a new top-level signal family) since a baseline is provenance
    // about that exact summary, the same category as `model`/`generatedAt`
    // — a regeneration overwrites the whole object, baseline included,
    // atomically, in the same merge-write. Omitted (never a partial/
    // zeroed-out triple) when baseline capture fails — e.g. the source file
    // vanished in the narrow window after generation — since that failure
    // must never block or fail the summary write itself (Phase 2 will
    // treat a Node with no baseline as simply not-yet-checkable for
    // staleness).
    sourceMtimeMs?: number;
    sourceSize?: number;
    sourceHash?: string;
  };
  // Story 1.8 Phase 2: whether this Node's source has drifted from the
  // baseline captured in `summary` (`summary-generator.ts`'s
  // `detectStaleness`) — a new top-level signal family in its own right
  // (AD-20), never nested inside `summary`, so a staleness write can never
  // touch `summary`'s own keys by construction: `mergeNodeRecord`'s
  // shallow top-level merge means a `{ stale }` partial simply cannot
  // reach into `summary`. Left `undefined` (never defaulted to `false`)
  // for a Node that hasn't been evaluated yet — no baseline recorded, or
  // no summary at all.
  stale?: boolean;
  /**
   * Story 2.2 (Phase 1): the qualitative LLM-judgment risk signal's
   * persisted text (FR8) — its own top-level signal family (AD-20), never
   * nested inside `summary`, mirroring `summary`'s own
   * text/model/generatedAt provenance shape so the two families stay
   * structurally consistent. Written only via `mergeNodeRecord`, same as
   * every other field here. This phase only adds the shape: no code in
   * this phase writes or reads this field — Phase 2 (generation) is the
   * first writer, Phase 3 (rendering) the first reader.
   *
   * Review round (patch): a single object, not an array or a keyed
   * collection — at most one judgment ever exists per Node, the same
   * single-current-value cardinality `summary` already has (never a history
   * of past judgments). A future regeneration overwrites this field
   * wholesale via the same atomic merge-write `summary` regeneration
   * already uses, never appends.
   */
  llmJudgment?: {
    text: string;
    model: string;
    generatedAt: string;
  };
  /**
   * Story 2.3 (Phase 2): findings ingested from external PR-review bots
   * (CodeRabbit, and Phase 3's Qodo) — its own top-level signal family
   * (AD-20), never nested inside `summary`/`llmJudgment`. Unlike those two
   * (at most one current value each), this is an array: multiple bots (or
   * multiple findings from the same bot) can legitimately coexist on one
   * Node, distinguished by each entry's own `sourceTool` field.
   *
   * A write here always replaces every entry for one `sourceTool` across
   * every Node first, then adds that tool's freshly-ingested findings back
   * (Always: "each pass for `sourceTool: 'CodeRabbit'` replaces that tool's
   * prior findings across every Node first" — `services/graph-service/
   * index.ts`'s `computeIngestionResult` is what implements this two-step
   * clear-then-write; this field itself enforces nothing about `sourceTool`
   * uniqueness, exactly like `mergeNodeRecord`'s own shallow top-level merge
   * enforces nothing about a family's internal shape). Entries from a
   * different `sourceTool` (e.g. Qodo, once Phase 3 exists) are left
   * untouched by a CodeRabbit-only pass.
   */
  ingestedFindings?: IngestedRiskSignal[];
}

const WRITE_DEBOUNCE_MS = 500;

// Bumped only if `NodeRecord`'s persisted shape ever needs a breaking
// change — recorded now, before any real data accumulates in the wild
// (review finding), so a future shape change has something concrete to key
// a migration off of rather than having to guess a file's vintage from its
// absence.
const SCHEMA_VERSION = 1;

/** The on-disk JSON shape — a version tag alongside the actual records map, never just the bare map. */
interface PersistedFile {
  version: number;
  records: Record<string, NodeRecord>;
}

let baseDir: string | undefined;
let currentProjectPath: string | undefined;
let currentSlug: string | undefined;
let records: Record<string, NodeRecord> = {};
let dirty = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

// Serializes `setActiveProject` calls (review finding): two overlapping
// `graphService:index` requests for different projects, arriving before the
// first project's own `setActiveProject` call has resolved, could otherwise
// interleave their flush/load I/O against the shared `records`/
// `currentSlug` module state — the same class of concurrency/correlation
// bug already fixed twice elsewhere in this build (Story 1.2, Story 1.4).
// Every call is chained onto this promise so calls are processed strictly
// one at a time, each fully settling before the next starts; the chain
// itself is never allowed to stay rejected (a failed call would otherwise
// permanently wedge every future call behind it), but each call's own
// returned promise still reflects its own real result.
let activeProjectQueue: Promise<void> = Promise.resolve();

/**
 * Sets the persistence root (`<userData>/node-records`). Must be called
 * once before `setActiveProject`/`mergeNodeRecord`/etc. do anything useful —
 * called from index.ts at module load, using the userData path main passed
 * as this subprocess's first fork argument.
 */
export function initNodeRecordStore(userDataPath: string): void {
  baseDir = path.join(userDataPath, 'node-records');
}

/**
 * A stable, filesystem-safe identifier for `projectPath` — a SHA-256 hash of
 * the absolute path, truncated to 16 hex characters (64 bits, ample
 * collision resistance for this store's scale: one file per locally-opened
 * project, never a shared/multi-tenant namespace).
 */
function projectSlug(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

function recordFilePath(slug: string): string {
  // initNodeRecordStore must run before this is ever reached (see its doc
  // comment) — asserted rather than silently defaulting to a wrong
  // directory, since a silent fallback here would risk quietly persisting
  // Node records somewhere other than userData.
  if (!baseDir) {
    throw new Error('node-record-store: initNodeRecordStore() was not called before use.');
  }
  return path.join(baseDir, `${slug}.json`);
}

/**
 * Switches the store's active project, loading that project's persisted
 * records from disk (or starting empty on first open — matrix: no error for
 * a not-yet-existing file). A no-op when `projectPath` is already the active
 * project (review-style guard, not from a spec finding but the same
 * reasoning AD-20 states explicitly): re-reading from disk on every
 * `graphService:index` request — including a re-index of the *same*
 * already-open project — would risk clobbering an in-memory write that
 * hasn't flushed yet (writes are debounced, see `scheduleWrite` below) with
 * a stale on-disk snapshot, which is exactly the "structural re-index
 * clobbers a previously-written field" failure AD-20 exists to prevent.
 * Switching to a genuinely different project first flushes the outgoing
 * project's pending writes so nothing is lost.
 */
export function setActiveProject(projectPath: string): Promise<void> {
  const thisCall = activeProjectQueue.then(() => setActiveProjectInternal(projectPath));
  // The queue chain itself must never stay rejected — a failed call would
  // otherwise permanently wedge every future call queued behind it. Each
  // caller still gets `thisCall`, which does carry the real
  // resolve/reject, so a failure is not hidden from whoever actually made
  // this call.
  activeProjectQueue = thisCall.catch(() => {});
  return thisCall;
}

async function setActiveProjectInternal(projectPath: string): Promise<void> {
  if (projectPath === currentProjectPath) {
    return;
  }
  await flushNodeRecordStore();

  currentProjectPath = projectPath;
  currentSlug = projectSlug(projectPath);
  records = await loadRecordsFromDisk(currentSlug);
}

async function loadRecordsFromDisk(slug: string): Promise<Record<string, NodeRecord>> {
  const filePath = recordFilePath(slug);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // First time this project has been opened — no records yet, not a
      // failure.
      return {};
    }
    console.error(
      `[graph-service] failed to read node record store at ${filePath}; starting fresh for this session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `[graph-service] node record store at ${filePath} contained invalid JSON; starting fresh for this session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `[graph-service] node record store at ${filePath} did not contain a JSON object; starting fresh for this session.`,
    );
    return {};
  }

  const { version, records: parsedRecords } = parsed as Partial<PersistedFile>;
  if (version !== SCHEMA_VERSION || !parsedRecords || typeof parsedRecords !== 'object') {
    // Either a version this build doesn't understand (future data opened by
    // an older build), or a shape from before `version` existed at all —
    // either way, there's nothing safe to migrate yet (v1 is the only
    // shape that has ever shipped), so this starts fresh rather than
    // guessing at a translation. `persistRecords` will write a fresh,
    // current-version file on the next write.
    console.warn(
      `[graph-service] node record store at ${filePath} has an unrecognized schema (version: ${String(version)}); starting fresh for this session.`,
    );
    return {};
  }
  return parsedRecords;
}

/** Reads a Node's full merged record, or `undefined` if it has none yet. */
export function getNodeRecord(id: string): NodeRecord | undefined {
  return records[id];
}

/**
 * Reads every persisted Node record for the currently active project, as a
 * shallow copy of the internal map (review finding) — a caller (Phase 2 will
 * be the first) that mutated the live internal object directly would
 * otherwise bypass the debounce/dirty-tracking entirely, silently diverging
 * from what's actually on disk. Note this is shallow: the individual
 * `NodeRecord` values are not themselves cloned, so mutating a returned
 * record's own nested fields in place is still unsafe — callers that need
 * to change a record must go through `mergeNodeRecord`.
 */
export function getAllNodeRecords(): Record<string, NodeRecord> {
  return { ...records };
}

/**
 * Merges `partial`'s top-level signal-family fields into the existing record
 * for `id` (AD-20) — never a full-record replace, so a write to one family
 * never touches another already written for the same Node. Persists via a
 * debounced batch write (see `scheduleWrite`), not one disk write per call.
 */
export function mergeNodeRecord(id: string, partial: Partial<NodeRecord>): void {
  records[id] = { ...records[id], ...partial };
  dirty = true;
  scheduleWrite();
}

function scheduleWrite(): void {
  if (writeTimer) {
    // Already scheduled — this call's change rides the pending timer rather
    // than resetting/duplicating it, so a burst of merges batches into one
    // disk write.
    return;
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void persistRecords().catch((error) => {
      console.error(
        `[graph-service] failed to persist node records: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, WRITE_DEBOUNCE_MS);
}

async function persistRecords(): Promise<void> {
  if (!dirty || !currentSlug) {
    return;
  }
  const filePath = recordFilePath(currentSlug);
  await mkdir(path.dirname(filePath), { recursive: true });
  // Write-to-temp-then-rename rather than writing `filePath` directly: a
  // crash or forced kill mid-write (main's 2s teardown fallback in
  // apps/desktop/main/index.ts) must never leave a half-written, corrupt
  // JSON file behind for the next `loadRecordsFromDisk` to choke on — this
  // phase's whole point is proving the persisted store is trustworthy.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const serialized = JSON.stringify({ version: SCHEMA_VERSION, records } satisfies PersistedFile);
  await writeFile(tmpPath, serialized, 'utf8');
  await rename(tmpPath, filePath);
  dirty = false;
}

/**
 * Flushes any pending debounced write immediately — called before switching
 * the active project (`setActiveProject`) and during Graph Service shutdown
 * (index.ts) so a merge that happened just before either event is never
 * silently lost to the debounce window.
 */
export async function flushNodeRecordStore(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    await persistRecords();
  } catch (error) {
    console.error(
      `[graph-service] failed to flush node records: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

