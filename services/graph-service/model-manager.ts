/**
 * Local LLM model download/verify (Story 1.5 Phase 1, AD-18).
 *
 * Picks a primary/fallback GGUF tier via a cheap `os.totalmem()` check,
 * resolves the Hugging Face file for that tier, fetches the *expected*
 * SHA-256 straight from the file's own LFS-pointer metadata (never
 * hardcoded — see this story's Design Notes: AD-18's threat model is
 * download corruption/truncation, not a compromised HF repo, and hardcoding
 * would need a driller source update every time the upstream quantization
 * is republished), downloads the real bytes via `node-llama-cpp`'s
 * `createModelDownloader`, hashes the downloaded file locally
 * (`node:crypto`), and only calls the model ready once the two match.
 *
 * Like `mcp-client.ts`, this module never touches `process.parentPort`
 * itself — it reports progress via plain callbacks and resolves/throws;
 * index.ts is what turns that into posted `graphService:modelStatus`
 * messages, mirroring how it already turns `indexRepository`'s
 * return/throw into posted `graphService:status` messages.
 *
 * Two timeouts guard against a silent hang (review finding — `fetch` alone
 * never times out, and neither does a stalled download): the metadata fetch
 * carries its own short `AbortSignal.timeout`, and the whole flow (metadata
 * fetch + download + hashing) is wrapped in a longer overall `withTimeout`,
 * mirroring mcp-client.ts's own two-tier timeout shape (its outer
 * `DEFAULT_TIMEOUT_MS` + the shorter `INDEX_STATUS_TIMEOUT_MS` follow-up).
 *
 * Runs only in the Graph Service subprocess (AD-18) — never the renderer —
 * same process boundary as `mcp-client.ts`.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { createModelDownloader as CreateModelDownloader } from 'node-llama-cpp';

// node-llama-cpp ships ESM-only (`"type": "module"`, no `require` export
// condition) with top-level await inside its dependency graph — live-tested
// (this story's verification pass) against this repo's actual bundling
// setup: the Graph Service subprocess builds to a CJS bundle (forge.config.
// ts's 'main' build target), and a `static import` of node-llama-cpp
// compiles down to a plain `require("node-llama-cpp")` there. Calling that
// at runtime throws `ERR_REQUIRE_ASYNC_MODULE` — Node's synchronous
// require-of-ESM interop explicitly refuses a target module whose graph
// contains top-level await, which node-llama-cpp's does. A dynamic
// `import()` (confirmed working against the real installed package) goes
// through the async ESM loader instead and has no such restriction, so this
// module lazily imports it instead of a static top-level import. Cached
// after the first successful import so a later `ensureLocalModel()` call in
// the same process doesn't pay the import cost twice.
let modelDownloaderModule: Promise<{ createModelDownloader: typeof CreateModelDownloader }> | undefined;

function loadModelDownloaderModule(): Promise<{
  createModelDownloader: typeof CreateModelDownloader;
}> {
  modelDownloaderModule ??= import('node-llama-cpp');
  return modelDownloaderModule;
}

interface ModelTierConfig {
  tier: 'primary' | 'fallback';
  /** Hugging Face repo id, e.g. "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF". */
  repoId: string;
  /** The exact GGUF filename within that repo (Q4_K_M quantization). */
  fileName: string;
}

// bartowski/Qwen2.5-Coder-*-Instruct-GGUF, Q4_K_M quantization (Intent,
// AD-18) — live-verified against Hugging Face (this story's verification
// pass): both repos publish exactly this filename for the Q4_K_M
// quantization, and both serve a `raw/main/<file>` LFS-pointer response in
// the `oid sha256:<hex>` shape `fetchExpectedSha256` below parses.
const PRIMARY_TIER: ModelTierConfig = {
  tier: 'primary',
  repoId: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF',
  fileName: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
};

const FALLBACK_TIER: ModelTierConfig = {
  tier: 'fallback',
  repoId: 'bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF',
  fileName: 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf',
};

// A cheap, coarse tier cutover (Design Notes judgment call — Phase 3 owns
// the real hardware-adequacy detection/cloud-switch nudge, explicitly out of
// scope here per the Never constraint). The Q4_K_M GGUF itself is under 1GB
// on disk for either tier, but llama.cpp inference also needs headroom for
// the OS, Electron's own footprint, and the model's KV cache — 8GiB total
// system RAM leaves that comfortably; below it, the 0.5B fallback tier is
// the safer first-run default rather than risking a swap-thrashing experience.
const LOW_RAM_THRESHOLD_BYTES = 8 * 1024 * 1024 * 1024;

function selectModelTier(): ModelTierConfig {
  return os.totalmem() >= LOW_RAM_THRESHOLD_BYTES ? PRIMARY_TIER : FALLBACK_TIER;
}

// The metadata fetch is a single small HTTP GET (a git-LFS pointer, a few
// hundred bytes) — 30s is generous slack for a slow connection while still
// catching a genuinely stalled/hung TCP connection promptly (review finding:
// `fetch` alone never times out on its own, so a stalled connection here
// used to hang `ensureLocalModel` forever with no error and no way for the
// UI to distinguish "stuck" from "slow").
const METADATA_FETCH_TIMEOUT_MS = 30 * 1000;

// A genuine hang-only safety net around the *entire* ensureLocalModel flow
// (metadata fetch + the real multi-hundred-MB-to-~1GB download + hashing),
// mirroring mcp-client.ts's DEFAULT_TIMEOUT_MS/withTimeout pattern for
// indexRepository — 30 minutes is well past what even a slow connection
// should need for this model size, so this is not a bound on legitimate
// large/slow downloads, only a backstop against a connection that stalls
// silently partway through (review finding: without this, a stalled
// download — as opposed to the already-short-timeout metadata fetch above —
// left `ensureLocalModel` hanging forever too).
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Races `promise` against a timeout, rejecting with a descriptive error if
 * `ms` elapses first. Duplicated from mcp-client.ts's own `withTimeout`
 * (not shared via a common module — this graph-service directory has no
 * existing shared-utility file, and this is a small enough helper that
 * duplicating it beats introducing one for a single reused function) — does
 * not (and, per the underlying `fetch`/downloader APIs, cannot always)
 * cancel the underlying work; it only stops the caller from waiting on it
 * forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fetches `tier`'s expected SHA-256 from Hugging Face's own file metadata —
 * a `GET .../raw/main/<file>` returns the file's git-LFS pointer as plain
 * text, of the form:
 *
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<64 lowercase hex chars>
 *   size <bytes>
 *
 * Throws if the request fails or the response doesn't contain a
 * recognizable `oid sha256:...` line — callers (`ensureLocalModel`) treat
 * that as a download-attempt failure (matrix: explicit error, never a
 * silent partial model).
 */
async function fetchExpectedSha256(tier: ModelTierConfig): Promise<string> {
  const metadataUrl = `https://huggingface.co/${tier.repoId}/raw/main/${tier.fileName}`;
  let response: Response;
  try {
    response = await fetch(metadataUrl, { signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `Failed to reach Hugging Face for ${tier.fileName}'s checksum metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Hugging Face returned HTTP ${response.status} fetching ${tier.fileName}'s checksum metadata (${metadataUrl}).`,
    );
  }
  const text = await response.text();
  const match = /oid sha256:([0-9a-f]{64})/i.exec(text);
  if (!match?.[1]) {
    throw new Error(
      `Hugging Face's file metadata for ${tier.fileName} did not contain a recognizable "oid sha256:..." LFS pointer.`,
    );
  }
  return match[1].toLowerCase();
}

/** Progress callback shape — a direct passthrough of `node-llama-cpp`'s own downloader progress fields. */
export interface ModelDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

/**
 * Downloads `tier`'s GGUF file into `dirPath` via `node-llama-cpp`'s
 * `createModelDownloader` (an HTTPS URI is one of its supported schemes),
 * relaying progress through `onProgress`. Returns the downloaded file's
 * absolute path. `skipExisting` (the downloader's own default) means a file
 * already on disk with a matching remote size completes near-instantly
 * without re-transferring — `ensureLocalModel` still re-verifies its
 * checksum every call regardless, so a stale-but-right-sized file is never
 * trusted on size alone.
 */
async function downloadModel(
  tier: ModelTierConfig,
  dirPath: string,
  onProgress: ((progress: ModelDownloadProgress) => void) | undefined,
): Promise<string> {
  const { createModelDownloader } = await loadModelDownloaderModule();
  const downloadUrl = `https://huggingface.co/${tier.repoId}/resolve/main/${tier.fileName}`;
  const downloader = await createModelDownloader({
    modelUri: downloadUrl,
    dirPath,
    fileName: tier.fileName,
    onProgress: onProgress
      ? (status) =>
          onProgress({ downloadedBytes: status.downloadedSize, totalBytes: status.totalSize })
      : undefined,
  });
  return downloader.download();
}

/** Streaming SHA-256 of a file on disk — avoids loading a ~1GB GGUF fully into memory just to hash it. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface EnsureLocalModelOptions {
  /**
   * The persistence root (`app.getPath('userData')` on the main-process
   * side) — this subprocess has no direct access to Electron's `app`
   * module, so main passes it down (see index.ts). The model is stored
   * under `<userDataPath>/models`.
   */
  userDataPath: string;
  /** Fired repeatedly while the download is in flight. */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** Fired once, after the download completes and before hashing starts. */
  onVerifying?: () => void;
}

export interface LocalModelReady {
  /** The verified model's filename — shown in the status indicator (Design Notes). */
  model: string;
  /** Absolute path to the verified GGUF file on disk. */
  path: string;
}

/**
 * Ensures the default local GGUF model is present and checksum-verified,
 * downloading it from Hugging Face on first use (AD-18). Throws on any
 * failure — checksum-metadata fetch, the download itself, or a checksum
 * mismatch — so the caller (index.ts) can turn that into the explicit
 * `graphService:modelStatus` error state (matrix: never a silently partial
 * model). A checksum mismatch additionally deletes the downloaded file so a
 * later retry's `skipExisting` check can't mistake the corrupt file already
 * on disk for a good one.
 */
export async function ensureLocalModel(
  options: EnsureLocalModelOptions,
): Promise<LocalModelReady> {
  return withTimeout(runEnsureLocalModel(options), DOWNLOAD_TIMEOUT_MS, 'ensureLocalModel');
}

async function runEnsureLocalModel(options: EnsureLocalModelOptions): Promise<LocalModelReady> {
  const tier = selectModelTier();
  const expectedSha256 = await fetchExpectedSha256(tier);

  const modelsDir = path.join(options.userDataPath, 'models');
  const modelPath = await downloadModel(tier, modelsDir, options.onProgress);

  options.onVerifying?.();
  const actualSha256 = await hashFile(modelPath);

  if (actualSha256 !== expectedSha256) {
    await unlink(modelPath).catch((error: unknown) => {
      // Best-effort cleanup — if the delete itself fails (e.g. a permission
      // error or the file being locked by another process), a later
      // retry's `skipExisting` check could mistake the still-corrupt file
      // for a good one. Not surfaced as the primary error (the checksum
      // mismatch below already is one), but logged so it isn't silently
      // swallowed (review finding).
      console.warn(
        `[graph-service] failed to delete corrupt model file at ${modelPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    throw new Error(
      `Downloaded model checksum mismatch for ${tier.fileName}: expected ${expectedSha256}, got ${actualSha256}. The download may be corrupt or truncated — try again.`,
    );
  }

  console.log(
    `[graph-service] local model ready: ${tier.fileName} (${tier.tier} tier), sha256 verified (${actualSha256}).`,
  );

  return { model: tier.fileName, path: modelPath };
}
