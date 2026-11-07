/* QMReader desktop bridge.
 *
 * The Renderer keeps the exact web frontend. This shim routes same-origin API
 * calls (and the public rss.qiaomu.ai endpoints that request-json.js reaches
 * for) through a Tauri command. Tauri passes each request to the Node bridge
 * over stdio; the Node bridge forwards it to Express over a Unix socket. The
 * returned body is exposed as a real ReadableStream so SSE chat works.
 */
(function installNativeBridge() {
  'use strict';
  if (window.__QM_NATIVE_BRIDGE__) return;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  window.__QM_NATIVE_BRIDGE__ = true;

  const PUBLIC_ORIGINS = new Set(['https://rss.qiaomu.ai', 'https://rss-edge.qiaomu.ai']);
  const invoke = (cmd, args) => internals.invoke(cmd, args);
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  let nextId = 1;
  invoke('native_log', {
    message: `[webview] bridge install location=${window.location.href} protocol=${window.location.protocol} purify=${typeof window.DOMPurify}`,
  }).catch(() => {});

  // Minimal counterpart of @tauri-apps/api Channel. `toJSON` produces the
  // __CHANNEL__ marker Tauri uses to hand a Rust Channel to a command.
  // Channel messages can arrive out of order; they carry an index and must be
  // delivered in that order (the stock Channel implementation does the same).
  function createChannel(onmessage) {
    let nextIndex = 0;
    let endIndex = Infinity;
    const buffered = new Map();
    let callbackId = 0;
    const deliver = message => {
      try { onmessage(message); } catch (error) {
        setTimeout(() => { throw error; }, 0);
      }
    };
    callbackId = internals.transformCallback(raw => {
      if (!raw || typeof raw !== 'object') return;
      const index = raw.index;
      if ('end' in raw) {
        if (index === nextIndex) {
          try { internals.unregisterCallback(callbackId); } catch { /* already gone */ }
        } else {
          endIndex = index;
        }
        return;
      }
      if (index === nextIndex) {
        deliver(raw.message);
        nextIndex += 1;
        while (buffered.has(nextIndex)) {
          deliver(buffered.get(nextIndex));
          buffered.delete(nextIndex);
          nextIndex += 1;
        }
        if (nextIndex === endIndex) {
          try { internals.unregisterCallback(callbackId); } catch { /* already gone */ }
        }
      } else {
        buffered.set(index, raw.message);
      }
    });
    return {
      id: callbackId,
      toJSON() { return `__CHANNEL__:${callbackId}`; },
    };
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function proxyTarget(rawUrl) {
    let url;
    try { url = new URL(rawUrl, window.location.href); } catch { return null; }
    const sameOrigin = url.protocol === window.location.protocol && url.host === window.location.host;
    if (sameOrigin || PUBLIC_ORIGINS.has(url.origin)) {
      return url.pathname + url.search;
    }
    return null;
  }

  async function nativeFetch(input, init) {
    const request = (typeof input === 'object' && input !== null && typeof input.url === 'string' && !(input instanceof URL)) ? input : null;
    const rawUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : request ? request.url : String(input));
    const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
    const target = proxyTarget(rawUrl);
    if (!target || !originalFetch) {
      return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    }

    const headerBag = new Headers(request ? request.headers : undefined);
    if (init && init.headers) new Headers(init.headers).forEach((value, key) => headerBag.set(key, value));
    const headers = {};
    headerBag.forEach((value, key) => { headers[key] = value; });

    let body = init && init.body !== undefined ? init.body : null;
    if (body === null && request && request.body && method !== 'GET' && method !== 'HEAD') {
      body = await request.text();
    }
    if (body !== null && typeof body !== 'string') {
      if (body instanceof URLSearchParams) body = body.toString();
      else if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body);
      else if (typeof Blob !== 'undefined' && body instanceof Blob) body = await body.text();
      else body = String(body);
    }

    const id = nextId++;
    const signal = (init && init.signal) || (request && request.signal) || null;
    let controller = null;
    let settledHead = false;
    let finished = false;
    let channel = null;
    let resolveHead;
    let rejectHead;
    const headPromise = new Promise((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    const stream = new ReadableStream({
      start(value) { controller = value; },
      cancel() { abort(); },
    });

    function cleanup() {
      if (finished) return;
      finished = true;
      if (channel) {
        try { internals.unregisterCallback(channel.id); } catch { /* already gone */ }
      }
    }

    function abort() {
      if (finished) return;
      finished = true;
      try { invoke('native_cancel', { id }); } catch { /* bridge already gone */ }
      const error = new DOMException('The operation was aborted.', 'AbortError');
      if (!settledHead) {
        settledHead = true;
        rejectHead(error);
      }
      try { if (controller) controller.error(error); } catch { /* stream already closed */ }
      try { if (channel) internals.unregisterCallback(channel.id); } catch { /* already gone */ }
    }

    channel = createChannel(message => {
      let payload;
      try { payload = JSON.parse(message); } catch { return; }
      if (payload.type === 'head') {
        if (!settledHead) {
          settledHead = true;
          resolveHead(payload);
        }
        return;
      }
      if (payload.type === 'chunk') {
        if (!controller || finished) return;
        try {
          const bytes = base64ToBytes(payload.data);
          controller.enqueue(bytes);
        } catch { /* stream cancelled */ }
        return;
      }
      if (payload.type === 'end') {
        try { if (controller) controller.close(); } catch { /* already closed */ }
        cleanup();
        return;
      }
      if (payload.type === 'error') {
        const error = new Error(payload.message || 'native request failed');
        if (!settledHead) {
          settledHead = true;
          rejectHead(error);
        }
        try { if (controller) controller.error(error); } catch { /* already closed */ }
        cleanup();
      }
    });

    if (signal) {
      if (signal.aborted) {
        abort();
        return headPromise;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    try {
      await invoke('native_fetch', {
        req: { id, method, path: target, headers, body },
        channel,
      });
    } catch (error) {
      if (!settledHead) {
        settledHead = true;
        rejectHead(error);
      }
      try { if (controller) controller.error(error); } catch { /* already closed */ }
      cleanup();
      return headPromise;
    }

    const head = await headPromise;
    const status = Number(head.status) || 200;
    const responseHeaders = new Headers(head.headers || {});
    const nullBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    if (nullBody) {
      try { if (controller) controller.close(); } catch { /* already closed */ }
      cleanup();
      return new Response(null, { status, statusText: head.statusText || '', headers: responseHeaders });
    }
    return new Response(stream, { status, statusText: head.statusText || '', headers: responseHeaders });
  }

  window.fetch = nativeFetch;

  // The web app registers a service worker for offline caching. Inside the
  // native shell the bundled files are authoritative, so registration is a
  // no-op (and a hidden source of stale assets otherwise).
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new Error('service worker disabled in desktop app'));
    }
  } catch { /* read-only in some webviews */ }

  // window.open would create a second webview; hand external URLs to the
  // system browser instead. OAuth screens fall back to their paste-the-URL UI.
  try {
    window.open = (url) => {
      if (url) {
        try { invoke('open_external', { url: new URL(String(url), window.location.href).href }); } catch { /* ignore */ }
      }
      return null;
    };
  } catch { /* read-only */ }

  // Same treatment for ordinary external anchors; app.js already intercepts
  // article-body links, this catches the remaining chrome links.
  document.addEventListener('click', event => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.protocol === window.location.protocol && url.host === window.location.host) return;
    event.preventDefault();
    event.stopPropagation();
    try { invoke('open_external', { url: url.href }); } catch { /* ignore */ }
  }, true);
})();
