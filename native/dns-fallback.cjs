'use strict';

/*
 * QMReader DNS fallback for proxy fake-IP environments.
 *
 * Some local proxies (Surge/Clash fake-IP mode) answer every DNS query with an
 * address from 198.18.0.0/15. QMReader's SSRF guard correctly refuses to fetch
 * a feed from a private address, so every refresh fails even though the proxy
 * can route the traffic.
 *
 * This preload resolves the real public address through DNS-over-HTTPS only
 * when the system resolver returned a non-public address (or failed). Public
 * results are then used by QMReader's pinned-lookup HTTP client. On a normal
 * network nothing changes and no DoH request is made.
 */

const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');

if (globalThis.__QMREADER_DNS_FALLBACK__) return;
globalThis.__QMREADER_DNS_FALLBACK__ = true;
if (process.env.QMREADER_DNS_FALLBACK === '0') return;

const originalLookup = dns.lookup.bind(dns);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 256;
const cache = new Map();

function isNonPublicIpAddress(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice(7);
    if (net.isIP(mapped) === 4) return isNonPublicIpAddress(mapped);
    return true;
  }
  const type = net.isIP(address);
  if (!type) return true;
  if (type === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  return address === '::'
    || address === '::1'
    || /^(?:fc|fd)/i.test(address)
    || /^fe[89ab]/i.test(address)
    || /^ff/i.test(address)
    || /^2001:db8(?::|$)/i.test(address);
}

function dohJson(hostname, type) {
  const providers = [
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
  ];
  const attempt = index => new Promise(resolve => {
    if (index >= providers.length) return resolve([]);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = https.request(providers[index], {
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        // Resolve the DoH provider with the original resolver. The proxy's
        // fake IP is what makes the provider reachable in these setups.
        lookup: originalLookup,
        timeout: 4000,
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 1024 * 1024) request.destroy(new Error('doh_response_too_large'));
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return attempt(index + 1).then(finish);
          try {
            const parsed = JSON.parse(body);
            const addresses = (parsed.Answer || [])
              .filter(answer => (answer.type === 1 || answer.type === 28) && answer.data)
              .map(answer => ({
                address: String(answer.data),
                family: answer.type === 1 ? 4 : 6,
              }))
              .filter(item => net.isIP(item.address) && !isNonPublicIpAddress(item.address));
            finish(addresses);
          } catch {
            attempt(index + 1).then(finish);
          }
        });
      });
    } catch {
      return attempt(index + 1).then(finish);
    }
    request.on('timeout', () => request.destroy(new Error('doh_timeout')));
    request.on('error', () => attempt(index + 1).then(finish));
    request.end();
  });
  return attempt(0);
}

async function resolvePublic(hostname, family) {
  const key = `${hostname}|${family || 0}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.addresses;
  const wanted = family === 4 ? [1] : family === 6 ? [28] : [1, 28];
  const lists = await Promise.all(wanted.map(type => dohJson(hostname, type === 1 ? 'A' : 'AAAA')));
  const addresses = lists.flat();
  if (addresses.length) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { addresses, expires: Date.now() + CACHE_TTL_MS });
  }
  return addresses;
}

function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  const family = Number(opts.family) || 0;
  const lookupOptions = { all: true };
  if (family) lookupOptions.family = family;
  if (opts.hints) lookupOptions.hints = opts.hints;
  if (opts.verbatim !== undefined) lookupOptions.verbatim = opts.verbatim;

  const respond = list => {
    const usable = (list || [])
      .map(item => (typeof item === 'string' ? { address: item, family: net.isIP(item) } : item))
      .filter(item => item && item.address && (item.family === 4 || item.family === 6));
    const filtered = family ? usable.filter(item => item.family === family) : usable;
    if (!filtered.length) {
      const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
      return callback(error);
    }
    if (opts.all) return callback(null, filtered.map(item => ({ address: item.address, family: item.family })));
    return callback(null, filtered[0].address, filtered[0].family);
  };

  originalLookup(hostname, lookupOptions, (error, addresses) => {
    const list = !error && Array.isArray(addresses) ? addresses : [];
    const needsDoh = Boolean(error) || !list.length || list.some(item => isNonPublicIpAddress(item.address));
    if (!needsDoh) return respond(list);
    resolvePublic(hostname, family)
      .then(publicAddresses => respond(publicAddresses && publicAddresses.length ? publicAddresses : list))
      .catch(() => respond(list));
  });
}

dns.lookup = patchedLookup;
if (dns.promises) {
  dns.promises.lookup = (hostname, options) => new Promise((resolve, reject) => {
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    patchedLookup(hostname, opts, (error, address, addressFamily) => {
      if (error) return reject(error);
      if (opts.all) return resolve(address);
      return resolve({ address, family: addressFamily });
    });
  });
}
