# QMReader for macOS

This directory documents the native macOS wrapper around the existing QMReader
web application. The wrapper does not reimplement any reader, account or AI
logic: `server.js`, `lib/` and all frontend files keep running as-is.

## Architecture

```
┌──────────────────────────── QMReader.app ────────────────────────────┐
│                                                                      │
│  WKWebView (tauri://localhost)                                       │
│    · public/ embedded by Tauri                                       │
│    · public/native-bridge.js replaces window.fetch / window.open     │
│                                                                      │
│            Tauri command "native_fetch" + Channel<String>            │
│                              │                                       │
│  Rust shell (Contents/MacOS/qmreader)                                │
│    · spawns Node and owns the stdio JSON-lines protocol              │
│                              │                                       │
│  Node bridge (Contents/MacOS/node + Resources/runtime/native)        │
│    · patches http.Server.prototype.listen before require(server.js)  │
│    · Express listens on $TMPDIR/qmreader-<pid>.sock (Unix socket)    │
│    · keeps the qm_session cookie jar, pins Host: localhost, strips   │
│      Origin/Sec-Fetch-Site so Express' CSRF check accepts requests    │
│    · streams head / chunk / end frames back over stdout              │
│                                                                      │
│  Express app (server.js + lib + node_modules, unchanged)             │
│    · data in ~/Library/Application Support/dev.qmreader.mac/data     │
└──────────────────────────────────────────────────────────────────────┘
```

* **No TCP port is opened.** Express' `listen()` call is intercepted and its
  target is replaced by a Unix domain socket in `$TMPDIR`. Rust holds one end of
  a stdio pipe pair with Node; the webview talks to Rust through Tauri's IPC
  (which uses the `ipc://` WebKit scheme).
* **Streaming**: Rust forwards each Node JSON line to a Tauri `Channel<String>`.
  `native-bridge.js` re-orders channel messages by index and exposes them as a
  real `ReadableStream`, so `/api/entry/:id/chat/stream` (SSE) works without
  buffering the whole answer.
* **Cookies**: the webview cannot persist `HttpOnly` cookies for `tauri://`
  responses, so the Node bridge stores `Set-Cookie` values and adds them to
  every proxied request. The jar is written to `session-cookies.json` (mode
  0600) and restored on launch, so login survives quitting the app. Deleting
  that file signs the app out.
* **CSRF**: the bridge drops `Origin`, `Sec-Fetch-*`, `Referer`, browser
  `Cookie`/`Accept-Encoding`, pins `Host: localhost`, and asks for identity
  encoding.
* **Static assets**: Tauri serves `public/` over its asset protocol.
  `<script src="/native-bridge.js">` is injected before `app.js`; nothing else in
  `public/` changed. `dompurify` is only served by a server route in the web
  build, so the build script copies `node_modules/dompurify/dist/purify.min.js`
  into `public/` for the duration of the Tauri build and deletes it afterwards.
* **DNS**: `native/dns-fallback.cjs` is preloaded in the bridge and inherited by
  all forked fetch workers; it only steps in when the system resolver returns a
  non-public or failed result (see the fake-IP note under limitations).
* **Service worker** registration is disabled in the native shell; bundled files
  are authoritative.
* **External links** (`window.open`, external anchors) are opened in the default
  browser instead of creating a second webview.

## Building

Prerequisites:

* macOS with Xcode Command Line Tools (`xcode-select -p` works)
* Rust toolchain (`cargo`, `rustc`)
* Node.js **>= 22.22** on `PATH` (the build copies this exact binary into the
  app; `node:sqlite` requires it)

Build from a clean checkout:

```bash
npm run build:mac
```

The script (`scripts/build-macos-app.sh`) performs, in order:

1. `npm ci` in the repository (also re-creates the root tooling).
2. Copies the current `node` executable to
   `src-tauri/binaries/node-aarch64-apple-darwin` (Tauri `externalBin`).
3. Stages `server.js`, `package.json`, `lib/`, `scripts/`, `public/`, `native/`,
   `.rss-reliability/` into `src-tauri/runtime/` (Tauri bundle resources).
4. `npm ci --omit=dev` inside `src-tauri/runtime/` for the bundled `node_modules`.
5. Copies `purify.min.js` into `public/` temporarily, runs
   `npx tauri build --bundles app`, then removes the copy via a shell `trap`.
6. Re-signs the bundled Node binary with its JIT entitlements
   (`src-tauri/node.entitlements`) and re-seals the app with ad-hoc signing.

Result:

```
src-tauri/target/release/bundle/macos/QMReader.app
```

Double-click the app, or run `open src-tauri/target/release/bundle/macos/QMReader.app`.

The app is ad-hoc signed (`codesign -s -`); it is not notarized. Locally built
copies launch normally. Distributing it to another Mac requires a Developer ID
signature and notarization.

## Data and logs

| What | Path |
| --- | --- |
| Application data / SQLite | `~/Library/Application Support/dev.qmreader.mac/data/` |
| Bridge + fetch worker log | `~/Library/Application Support/dev.qmreader.mac/logs/native.log` |
| Webview bridge log | `~/Library/Application Support/dev.qmreader.mac/logs/webview.log` |
| Unix socket (transient) | `$TMPDIR/qmreader-<pid>.sock` |
| Session cookie jar (0600) | `~/Library/Application Support/dev.qmreader.mac/session-cookies.json` |
| Optional admin seed file | `~/Library/Application Support/dev.qmreader.mac/admin.env` |
| Optional server-side AI config | `~/Library/Application Support/dev.qmreader.mac/ai.env` |

`QMREADER_DATA_DIR` is set by the bridge at startup from Tauri's
`app_data_dir()`; paths are never hard-coded.

### ai.env

Background jobs — title translation and automatic rewrites — call the
server-side provider, not the per-request AI settings kept in the webview. A
double-clicked app inherits no shell environment, so `ai.env` (same `KEY=VALUE`
format as `admin.env`) is where those jobs get their provider:

```ini
AI_PROVIDER=openai
AI_BASE_URL=http://127.0.0.1:3425/v1
AI_API_KEY=...
AI_MODEL=opencode-go/deepseek-v4.1-flash
AUTO_REWRITE_LIMIT_PER_SOURCE=5
TITLE_TRANSLATION_LIMIT=80
```

Only `AI_*`, `AUTO_REWRITE_*` and `TITLE_TRANSLATION_LIMIT` are honored. The
desktop build also sets `QMREADER_ALLOW_LOCAL_AI=1`, which lets the SSRF guard
accept loopback Base URLs over plain HTTP while still rejecting LAN ranges.


### Admin account

A double-clicked app inherits no shell environment, so the upstream
`ADMIN_EMAIL` / `ADMIN_PASSWORD` seed cannot be passed from a terminal. Instead,
create `admin.env` in the app data directory:

```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=your-password-here
ADMIN_NAME=Your Name
```

Restart the app. `seedAdminFromEnv()` runs on startup and creates or promotes
that account (existing environment variables still win). The file is read by the
bridge only for those three keys.

## Headless bridge test

The bridge has a stdin mode used by the build/QA checks:

```bash
echo '{"id":1,"method":"GET","path":"/api/sources"}' \
  | QMREADER_SERVER_ROOT="$PWD" node native/bridge.cjs --stdio-test
```

It starts the real Express app on a temporary Unix socket, forwards the request,
and prints one JSON object (`id`, `status`, `headers`, `body`). Diagnostics go to
stderr, never to the JSON stream. In this mode the data directory is a temporary
folder unless `QMREADER_APP_DATA_DIR` is set.

## Known limitations

* **No notarization / ad-hoc signature.** First launch on the build machine is
  fine. Moving the `.app` to a machine that enforces Gatekeeper requires proper
  signing and notarization.
* **App size ≈ 141 MB** because the Node runtime (≈117 MB) and production
  `node_modules` are shipped inside the bundle.
* **AI OAuth redirect providers (OpenRouter/TokenDance)**: `window.open` opens
  the provider in the system browser. The provider redirects to the public
  `https://rss.qiaomu.ai` callback, which has no session for the desktop user;
  use the dialog's "paste the URL after login" field. Codex/ChatGPT-style
  providers already use the paste flow.
* **Service worker offline cache is disabled** in the native shell.
* **RSS fetching in fake-IP proxy environments**: QMReader's SSRF guard rejects
  non-public addresses. Some local proxies (e.g. Surge) answer every DNS query
  with `198.18.0.0/15`, so refreshes would fail with
  `原文链接不能解析到本机或内网地址`. The bridge preloads
  `native/dns-fallback.cjs` and adds it to `NODE_OPTIONS`, so the Express process
  and every forked fetch worker use it. Only when the system resolver returns a
  non-public address (or fails) does it resolve the real public A/AAAA records
  over DNS-over-HTTPS (Google, then Cloudflare) and hand those to QMReader's
  pinned HTTP client. On a normal network no DoH request is made. Set
  `QMREADER_DNS_FALLBACK=0` in the app's environment to disable this behavior
  (e.g. `launchctl setenv QMREADER_DNS_FALLBACK 0` before launching). Edge case:
  if the proxy cannot route the real public address, fetching still fails.
* **No auto-update** and no multi-instance coordination. Opening the app twice
  starts two bridges pointing at the same SQLite database (WAL keeps this safe,
  but avoid it).
* **Lab collection writes**: `server.js` has one hard-coded `__dirname/data`
  path for `lib/lab-collection`. The bridge redirects `runtime/data` reads and
  writes to the app data directory without patching upstream code.

## Verification checklist

```bash
# build
npm ci
npm run build:mac

# run
open src-tauri/target/release/bundle/macos/QMReader.app

# processes (replace with real pids)
pgrep -fl 'QMReader.app/Contents/MacOS/(qmreader|node)'

# no TCP listener for either process
lsof -nP -a -iTCP -sTCP:LISTEN -p <qmreader-pid>   # empty
lsof -nP -a -iTCP -sTCP:LISTEN -p <node-pid>       # empty

# data
ls ~/Library/Application\ Support/dev.qmreader.mac/data

# headless bridge
echo '{"id":1,"method":"GET","path":"/api/sources"}' \
  | QMREADER_SERVER_ROOT="$PWD" node native/bridge.cjs --stdio-test
```
