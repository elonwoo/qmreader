#!/usr/bin/env node
'use strict';

/*
 * QMReader native bridge.
 *
 * Runs the existing Express application unchanged, except that its HTTP server
 * listens on a Unix domain socket instead of a TCP port. The Tauri shell talks
 * to this process with newline-delimited JSON over stdin/stdout:
 *
 *   ->  {"id":1,"method":"GET","path":"/api/sources","headers":{},"body":null}
 *   <-  {"id":1,"type":"head","status":200,"headers":{...}}
 *   <-  {"id":1,"type":"chunk","data":"<base64>"}
 *   <-  {"id":1,"type":"end"}
 *
 * Every request owns an HTTP connection to the Unix socket. The bridge keeps a
 * cookie jar for qm_session (the webview cannot store HttpOnly cookies for
 * tauri:// responses), strips browser CSRF headers, and pins Host to localhost.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const util = require('node:util');

const TEST_MODE = process.argv.includes('--stdio-test');
const protocolOut = process.stdout.write.bind(process.stdout);

// The Express app logs through console.*; those bytes must never reach the IPC
// stream. Keep them on stderr so the Tauri side can forward them to a log file.
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
  console[level] = (...args) => {
    try { process.stderr.write(`${util.format(...args)}\n`); } catch { /* stderr closed */ }
  };
}

const serverRoot = path.resolve(process.env.QMREADER_SERVER_ROOT || path.join(__dirname, '..'));
const appDataRoot = process.env.QMREADER_APP_DATA_DIR
  ? path.resolve(process.env.QMREADER_APP_DATA_DIR)
  : TEST_MODE
    ? path.join(os.tmpdir(), `qmreader-stdio-test-${process.pid}`)
    : path.join(os.homedir(), 'Library', 'Application Support', 'dev.qmreader.mac');
const dataDir = path.join(appDataRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.QMREADER_DATA_DIR = dataDir;
// A desktop install is single-user, so the public site's SSRF guard would only
// block the owner's own loopback gateway (magpie, Ollama, LM Studio). Opt in;
// set QMREADER_ALLOW_LOCAL_AI=0 before launch to restore the upstream rule.
if (process.env.QMREADER_ALLOW_LOCAL_AI === undefined) process.env.QMREADER_ALLOW_LOCAL_AI = '1';
// .rss-reliability/source-child.cjs resolves lib/fetcher.js from RSS_APP_DIR;
// without it the forked source workers target the upstream production path.
if (!process.env.RSS_APP_DIR) process.env.RSS_APP_DIR = serverRoot;

// A double-clicked app inherits no shell environment. Allow an optional local
// admin.env (KEY=VALUE lines) in the app data directory so seedAdminFromEnv can
// create/promote the admin account. Only the ADMIN_* keys are honored.
try {
  const adminEnvFile = path.join(appDataRoot, 'admin.env');
  for (const line of fs.readFileSync(adminEnvFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(ADMIN_EMAIL|ADMIN_PASSWORD|ADMIN_NAME)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[bridge] admin.env ignored:', error.message || error);
}

// Background jobs (title translation, automatic rewrites) use the server-side
// provider, not the per-request AI settings stored in the webview. ai.env gives
// a desktop install a place to point those jobs at a local gateway, where the
// shell has no environment to inherit. Only provider keys are honored.
try {
  const aiEnvFile = path.join(appDataRoot, 'ai.env');
  for (const line of fs.readFileSync(aiEnvFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(AI_PROVIDER|AI_PROVIDER_TYPE|AI_API_KEY|AI_BASE_URL|AI_MODEL|AI_TEMPERATURE|AI_MAX_TOKENS|AI_REQUEST_TIMEOUT_MS|AI_DISABLE_THINKING|AUTO_REWRITE_MODEL|AUTO_REWRITE_SOURCE_IDS|AUTO_REWRITE_LIMIT_PER_SOURCE|REWRITE_CONCURRENCY|TITLE_TRANSLATION_LIMIT)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[bridge] ai.env ignored:', error.message || error);
}

if (!TEST_MODE && typeof process.env.QMREADER_APP_DATA_DIR !== 'string') {
  console.warn('[bridge] QMREADER_APP_DATA_DIR was not provided; using', appDataRoot);
}

// Fake-IP proxies defeat the SSRF guard; resolve real public addresses via DoH
// for this process and every Node worker it forks (NODE_OPTIONS is inherited).
const dnsFallback = path.join(__dirname, 'dns-fallback.cjs');
try { require(dnsFallback); } catch (error) {
  console.warn('[bridge] DNS fallback unavailable:', error.message || error);
}
if (!String(process.env.NODE_OPTIONS || '').includes('dns-fallback.cjs')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${dnsFallback}`.trim();
}

// server.js resolves pack-relative paths from its own directory.
process.chdir(serverRoot);

// A few internal features (lab-collection) still write to <serverRoot>/data.
// Redirect that directory to the per-user data directory without touching the
// upstream source.
const bundledDataDir = path.resolve(serverRoot, 'data');
const redirectBundledData = (value) => {
  if (typeof value !== 'string') return value;
  const resolved = path.resolve(value);
  if (resolved === bundledDataDir) return dataDir;
  if (resolved.startsWith(bundledDataDir + path.sep)) {
    return path.join(dataDir, path.relative(bundledDataDir, resolved));
  }
  return value;
};
for (const method of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'statSync', 'unlinkSync', 'openSync', 'appendFileSync', 'copyFileSync']) {
  const original = fs[method];
  if (typeof original !== 'function') continue;
  fs[method] = function redirectedBundledData(...args) {
    if (args.length) args[0] = redirectBundledData(args[0]);
    if (method === 'renameSync' || method === 'copyFileSync') {
      if (args.length > 1) args[1] = redirectBundledData(args[1]);
    }
    return original.apply(this, args);
  };
}
const originalRenameSync = fs.renameSync;
fs.renameSync = function redirectedRename(...args) {
  if (args.length > 1) args[1] = redirectBundledData(args[1]);
  return originalRenameSync.apply(this, args);
};

const socketPath = process.env.QMREADER_SOCKET
  || path.join(os.tmpdir(), `qmreader-bridge-${process.pid}.sock`);
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

let resolveReady;
let readyPromise = new Promise(resolve => { resolveReady = resolve; });
let ready = false;
function markReady() {
  if (ready) return;
  ready = true;
  if (!TEST_MODE) writeMessage({ type: 'ready' });
  resolveReady();
}

function writeMessage(message) {
  protocolOut(`${JSON.stringify(message)}\n`);
}

// Replace the listen target. server.js calls app.listen(PORT, HOST, cb); the
// callback seeds the admin account, loads the disk cache and starts the four
// refresh schedulers, so it must still run.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function nativeListen(...args) {
  let callback = null;
  for (let i = args.length - 1; i >= 0; i -= 1) {
    if (typeof args[i] === 'function') { callback = args[i]; break; }
  }
  return originalListen.call(this, { path: socketPath }, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    console.log(`[bridge] Express listening on unix:${socketPath}`);
    markReady();
    if (callback) callback();
  });
};

// Load the untouched application after the listen hook is in place.
const serverModulePath = path.join(serverRoot, 'server.js');
try {
  require(serverModulePath);
} catch (error) {
  console.error('[bridge] failed to load server.js:', error && error.stack ? error.stack : error);
  process.exit(1);
}

const cookieJar = new Map();
const cookieJarFile = path.join(appDataRoot, 'session-cookies.json');
const active = new Map();
let nextResponseId = 0;

// qm_session has a Max-Age, so the web version keeps the user signed in across
// restarts. The jar lives in this process, so persist it (mode 0600) and restore
// it on the next launch.
try {
  const saved = JSON.parse(fs.readFileSync(cookieJarFile, 'utf8'));
  for (const [name, value] of Object.entries(saved || {})) {
    if (typeof value === 'string') cookieJar.set(name, value);
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[bridge] session cookie file ignored:', error.message || error);
}

function persistCookieJar() {
  try {
    const temp = `${cookieJarFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(cookieJar)), { mode: 0o600 });
    fs.renameSync(temp, cookieJarFile);
    fs.chmodSync(cookieJarFile, 0o600);
  } catch (error) {
    console.warn('[bridge] could not persist session cookies:', error.message || error);
  }
}

function updateCookieJar(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  let changed = false;
  for (const raw of values) {
    const match = /^([^=;\s]+)=([^;]*)/.exec(String(raw || ''));
    if (!match) continue;
    const name = match[1];
    const value = match[2];
    const maxAge = /;\s*Max-Age=(-?\d+)/i.exec(raw);
    const expired = (maxAge && Number(maxAge[1]) <= 0)
      || /;\s*Expires=Thu, 01 Jan 1970/i.test(raw)
      || value === '';
    if (expired) {
      if (cookieJar.delete(name)) changed = true;
    } else if (cookieJar.get(name) !== value) {
      cookieJar.set(name, value);
      changed = true;
    }
  }
  if (changed) persistCookieJar();
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function sanitizeHeaders(input) {
  const dropped = new Set([
    'host', 'origin', 'referer', 'cookie', 'content-length', 'connection',
    'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'upgrade',
    'expect', 'accept-encoding',
  ]);
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input || {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const name = String(rawName).toLowerCase();
    if (dropped.has(name) || name.startsWith('sec-fetch-') || name.startsWith(':')) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  headers.host = 'localhost';
  headers['accept-encoding'] = 'identity';
  const cookies = cookieHeader();
  if (cookies) headers.cookie = cookies;
  return headers;
}

function safeRequestPath(value) {
  const target = String(value || '/');
  if (!target.startsWith('/')) throw new Error('invalid request path');
  if (/[\r\n]/.test(target)) throw new Error('invalid request path');
  return target;
}

function filterResponseHeaders(rawHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'trailer'].includes(key)) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function cleanBody(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function forward(request) {
  const id = request.id;
  const method = String(request.method || 'GET').toUpperCase();
  const body = cleanBody(request.body);
  let finishTest = null;
  const testDone = TEST_MODE ? new Promise(resolve => { finishTest = resolve; }) : null;
  const completeTest = () => {
    if (finishTest) { finishTest(); finishTest = null; }
  };
  let headers;
  let requestPath;
  try {
    headers = sanitizeHeaders(request.headers);
    requestPath = safeRequestPath(request.path);
  } catch (error) {
    writeMessage({ id, type: 'error', message: error.message });
    completeTest();
    return testDone;
  }
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(body));

  let responded = false;
  let headSent = false;
  const fail = (message) => {
    if (responded) { completeTest(); return; }
    responded = true;
    active.delete(id);
    writeMessage({ id, type: 'error', message: String(message || 'request failed') });
    completeTest();
  };

  const clientRequest = http.request({
    socketPath,
    method,
    path: requestPath,
    headers,
  }, response => {
    if (responded) { response.resume(); return; }
    updateCookieJar(response.headers['set-cookie']);
    const responseHeaders = filterResponseHeaders(response.headers);
    if (TEST_MODE) {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        responded = true;
        active.delete(id);
        emitTestResult(id, response, responseHeaders, Buffer.concat(chunks));
        completeTest();
      });
      response.on('error', error => fail(error.message));
      return;
    }
    headSent = true;
    writeMessage({
      id,
      type: 'head',
      status: response.statusCode || 200,
      statusText: response.statusMessage || '',
      headers: responseHeaders,
    });
    response.on('data', chunk => {
      writeMessage({ id, type: 'chunk', data: chunk.toString('base64') });
    });
    response.on('end', () => {
      responded = true;
      active.delete(id);
      writeMessage({ id, type: 'end' });
    });
    response.on('error', error => {
      responded = true;
      active.delete(id);
      writeMessage({ id, type: 'error', message: error.message });
    });
  });

  clientRequest.on('error', error => {
    if (!headSent) fail(error.message || 'request failed');
  });
  active.set(id, clientRequest);
  if (body !== null) clientRequest.write(body);
  clientRequest.end();
  return testDone;
}

const testQueue = [];
let testRunning = false;

function emitTestResult(id, response, headers, buffer) {
  const text = buffer.toString('utf8');
  let parsed = text;
  if (String(headers['content-type'] || '').includes('json')) {
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
  }
  protocolOut(`${JSON.stringify({
    id,
    status: response.statusCode || 0,
    statusText: response.statusMessage || '',
    headers,
    body: parsed,
  })}\n`);
}

async function drainTestQueue() {
  if (testRunning) return;
  testRunning = true;
  await readyPromise;
  while (testQueue.length) {
    const entry = testQueue.shift();
    try {
      const id = entry.id != null ? entry.id : (nextResponseId += 1);
      entry.id = id;
      await forward(entry);
    } catch (error) {
      protocolOut(`${JSON.stringify({ id: entry.id, type: 'error', message: error.message })}\n`);
    }
  }
  // Give libuv a turn to flush the socket responses before shutting down.
  setTimeout(() => {
    try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
  }, 250);
}

function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch {
    console.error('[bridge] invalid JSON on stdin');
    return;
  }
  if (message.type === 'shutdown') {
    try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
    return;
  }
  if (message.cancel != null && message.method == null && message.path == null) {
    const pending = active.get(message.cancel);
    if (pending) {
      active.delete(message.cancel);
      try { pending.destroy(new Error('cancelled')); } catch { /* already gone */ }
    }
    return;
  }
  if (TEST_MODE) {
    testQueue.push(message);
    void drainTestQueue();
    return;
  }
  forward(message);
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf('\n');
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    handleLine(line);
    newline = stdinBuffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (TEST_MODE) {
    if (!testQueue.length && !testRunning) {
      void readyPromise.then(() => setTimeout(() => {
        try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
      }, 50));
    }
    return;
  }
  try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
});

process.on('SIGTERM', () => {
  try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
  // server.js installs its own SIGTERM handler that flushes state and exits.
});
process.on('exit', () => {
  try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
});

process.on('uncaughtException', error => {
  console.error('[bridge] uncaught exception:', error && error.stack ? error.stack : error);
  if (!TEST_MODE) {
    for (const id of active.keys()) writeMessage({ id, type: 'error', message: 'bridge crashed' });
  }
  process.exit(1);
});
process.on('unhandledRejection', error => {
  console.error('[bridge] unhandled rejection:', error && error.stack ? error.stack : error);
});
