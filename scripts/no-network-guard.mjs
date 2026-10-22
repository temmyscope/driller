/**
 * `--import` preload for `npm test` (P4-8a): no test may reach the network.
 *
 * `scripts/find-tests.mjs` loads this ahead of the TS loader, and `node
 * --test` hands the same `--import` flags to every test file's process, so
 * each file runs with these hooks installed before its first import.
 *
 * Wrapped: `net.Socket.prototype.connect` (which `net`, `tls`, `http`,
 * `https` and undici all go through), `globalThis.fetch` and
 * `globalThis.WebSocket`. Any host other than `127.0.0.1`, `::1` or
 * `localhost` — or a Unix socket / named-pipe path — throws
 * `NetworkDisabledInTests: <host>`. Loopback stays allowed: the MCP client
 * tests talk to a server on 127.0.0.1.
 *
 * A test that catches the error would hide the attempt, so every refused
 * attempt is also remembered and fails its file's process on exit.
 *
 * Opt-out is per file only: a top-of-file `// @allow-network: <reason>`
 * comment, which the runner reads and passes here as
 * `DRILLER_ALLOW_NETWORK_FILES`. Adding one needs founder approval.
 * Node subprocesses a test starts get this guard too: the runner puts it in
 * `NODE_OPTIONS`. Not covered: `dgram` (UDP), raw `dns` lookups, and
 * `worker_threads` workers (a worker doesn't run the main thread's
 * `--import` preloads, so its `fetch` and sockets are unwrapped).
 */
import net from 'node:net';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function canonical(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function allowListedFiles() {
  try {
    const parsed = JSON.parse(process.env.DRILLER_ALLOW_NETWORK_FILES ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The test file this process runs (`node --test` passes it as argv[1]). */
const testFile = process.argv[1] === undefined ? undefined : canonical(process.argv[1]);
const testFileLabel =
  testFile === undefined ? 'this process' : path.relative(process.cwd(), testFile) || testFile;

class NetworkDisabledInTests extends Error {}
// On the prototype, so the stack header V8 captures at construction already
// reads `NetworkDisabledInTests: <host>`.
NetworkDisabledInTests.prototype.name = 'NetworkDisabledInTests';

const refusedHosts = [];

function isLoopback(host) {
  const bare = String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return LOOPBACK_HOSTS.has(bare);
}

/** Throws for a non-loopback host; returns quietly otherwise. */
function refuseUnlessLoopback(host) {
  if (isLoopback(host)) return;
  refusedHosts.push(String(host));
  const error = new NetworkDisabledInTests(
    `${host} (in ${testFileLabel}: non-loopback network is disabled under npm test; ` +
      'a top-of-file "// @allow-network: <reason>" opts a file out, with founder approval)',
  );
  error.code = 'ERR_NETWORK_DISABLED_IN_TESTS';
  throw error;
}

/** The host a `Socket#connect` call targets, or `undefined` for a local socket path. */
function socketConnectHost(args) {
  // `net.connect()` passes its internal normalized form: `[[options, cb]]`.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') {
    // Only a non-empty string path makes Node use a local socket; `path: ''`
    // falls through to TCP on `host`.
    if (typeof first.path === 'string' && first.path !== '') return undefined;
    return first.host ?? 'localhost';
  }
  if (typeof first === 'string' && first !== '' && !/^\d+$/.test(first)) return undefined; // connect(path)
  return typeof args[1] === 'string' ? args[1] : 'localhost'; // connect(port[, host])
}

/** The host a URL-taking API targets, or `undefined` when the URL isn't network (data:, blob:) or doesn't parse (the real API reports that). */
function urlHost(input) {
  let raw = input;
  if (input instanceof URL) raw = input.href;
  else if (input !== null && typeof input === 'object' && typeof input.url === 'string') raw = input.url;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return undefined;
  }
  return WEB_PROTOCOLS.has(url.protocol) ? url.hostname : undefined;
}

function install() {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const host = socketConnectHost(args);
    if (host !== undefined) refuseUnlessLoopback(host);
    return originalConnect.apply(this, args);
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function fetch(input, init) {
      const host = urlHost(input);
      if (host !== undefined) {
        try {
          refuseUnlessLoopback(host);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return originalFetch.call(this, input, init);
    };
  }

  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    globalThis.WebSocket = class WebSocket extends OriginalWebSocket {
      constructor(url, protocols) {
        const host = urlHost(url);
        if (host !== undefined) refuseUnlessLoopback(host);
        super(url, protocols);
      }
    };
  }

  // A refused attempt the test caught (or that code under test swallowed)
  // must still fail the file: a non-zero exit fails it under `node --test`.
  process.on('exit', () => {
    if (refusedHosts.length === 0) return;
    process.stderr.write(
      `NetworkDisabledInTests: ${testFileLabel} attempted non-loopback network access ` +
        `(${[...new Set(refusedHosts)].join(', ')}); failing the file.\n`,
    );
    process.exitCode = 1;
  });
}

if (testFile === undefined || !allowListedFiles().includes(testFile)) {
  install();
  // P5-c review round 1: the e2e harness's positive control. With this set
  // (only the harness's `appEnv` sets it), each guarded process says so on
  // stderr, so a run can prove the Graph Service's guard output was
  // captured before trusting "no host refused".
  if (process.env.DRILLER_NETWORK_GUARD_ANNOUNCE === '1') {
    process.stderr.write(`NetworkGuardActive: ${testFileLabel}\n`);
  }
}
