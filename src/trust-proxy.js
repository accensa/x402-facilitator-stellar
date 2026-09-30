/**
 * Secure client-IP resolution behind reverse proxies and CDNs.
 *
 * Rate limiting keys on `req.keyId || req.ip` (src/rate-limit.js), so what
 * `req.ip` carries IS the caller's identity: resolve it wrong in the
 * spoofable direction and an attacker picks their own rate-limit bucket by
 * writing a header. This module is the single choke point that decides what
 * `req.ip` is allowed to mean; src/app.js installs its hook ahead of the
 * pseudonymiser (src/ip.js) so every consumer — limiter, audit, catalog
 * warning — sees the resolved address.
 *
 * The threat model is the `X-Forwarded-For` (XFF) chain. Each proxy appends
 * the address it received the connection from, so the chain reads left to
 * right as "claimed client → oldest proxy → … → proxy closest to us", and
 * the RIGHTMOST entry is the only one a trusted proxy vouches for. An
 * attacker in front of the trusted chain can prepend anything they like;
 * entries left of the trust boundary are noise and are never believed.
 *
 * Three trust shapes are accepted (parsed from TRUST_PROXY by src/config.js):
 *
 *   1. unset — no proxy is trusted. `req.ip` is the TCP peer and every
 *      forwarding header is ignored. Correct for local development and
 *      docker-compose, where the port is published directly.
 *
 *   2. a hop count N — the peer plus the N−1 rightmost XFF entries are
 *      trusted, and the client IP is the entry immediately left of that
 *      boundary. `TRUST_PROXY=1` is the one-proxy case (a single ingress, an
 *      AWS ALB): the rightmost XFF entry is the proxy's own view of the
 *      caller. N must equal the real number of trusted hops. When N reaches
 *      past the leftmost entry — the chain is shorter than the operator's
 *      trust claim — resolution fails closed to the peer rather than
 *      believing a client-written leftmost entry.
 *
 *   3. a proxy list — IPs, CIDRs, or the Express presets (loopback,
 *      linklocal, uniquelocal). The chain is walked from the peer right to
 *      left, skipping entries the list trusts; the first non-matching entry
 *      is the client IP. An untrusted peer means the whole header is
 *      ignored, whatever it claims.
 *
 * Cloudflare needs no configuration. When the TCP peer is one of
 * Cloudflare's published anycast ranges (below), `CF-Connecting-IP` is
 * honored: that header is written by Cloudflare's edge on requests that
 * traverse it, so the peer check IS the trust boundary — no client can
 * hold a Cloudflare source address without going through Cloudflare. From
 * any other peer the header is ignored, because there it is just another
 * client-writable value.
 *
 * AWS ALB sets no client-IP header of its own; it appends the client
 * address to XFF. `TRUST_PROXY=1` resolves that correctly (the ALB is the
 * trusted peer, the rightmost XFF entry is the client). Where the ALB's
 * address is stable enough to pin — a dedicated subnet — list its CIDR
 * instead: `TRUST_PROXY=10.0.1.0/24`. AWS publishes no stable ALB range
 * worth embedding (the EC2 space is huge and changes weekly), so a CIDR
 * list is the supported mechanism.
 */
import net from 'node:net';

/**
 * Cloudflare's published anycast ranges, mirrored from
 * https://www.cloudflare.com/ips/ — the authoritative, occasionally updated
 * list. Re-check it when touching these.
 */
export const CLOUDFLARE_IPV4_RANGES = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]);

export const CLOUDFLARE_IPV6_RANGES = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]);

/** Express `trust proxy` presets, mirroring proxy-addr's named ranges. */
const NET_PRESETS = {
  loopback: ['127.0.0.1/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/**
 * Parses an IPv4 or IPv6 address into `{ kind, value }`, where value is a
 * BigInt in the address's own 32/128-bit space. Returns null for anything
 * that is not a bare IP address (ports, hostnames, zone ids).
 *
 * @param {string} ip
 * @returns {{kind: 4|6, value: bigint}|null}
 */
function parseIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (net.isIP(trimmed) === 4) {
    return { kind: 4, value: ipv4ToBigInt(trimmed) };
  }
  if (net.isIP(trimmed) === 6) {
    const value = ipv6ToBigInt(trimmed);
    return value === null ? null : { kind: 6, value };
  }
  return null;
}

function ipv4ToBigInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

/**
 * IPv6 → 128-bit BigInt. Handles "::" compression and the embedded-IPv4 tail
 * (e.g. "::ffff:1.2.3.4"), which occupies the low 32 bits.
 *
 * @param {string} ip - a string net.isIP already validated as IPv6
 * @returns {bigint|null}
 */
function ipv6ToBigInt(ip) {
  let tailValue = 0n;
  let head = ip;
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    // The tail is an IPv4 address: it fills the last two 16-bit groups.
    tailValue = ipv4ToBigInt(tail);
    head = `${ip.slice(0, lastColon + 1)}0:0`;
  }

  const sides = head.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] === '' ? [] : sides[0].split(':');
  const right = sides.length === 2 ? (sides[1] === '' ? [] : sides[1].split(':')) : null;

  // Without "::" the address must be exactly 8 groups.
  if (right === null && left.length !== 8) return null;

  const missing = 8 - left.length - (right === null ? 0 : right.length);
  if (missing < 0) return null;

  const groups = right === null ? left : [...left, ...Array(missing).fill('0'), ...right];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value | tailValue;
}

/** True when a 128-bit BigInt is in ::ffff:0:0/96. */
function isIpv4Mapped(value) {
  return value >> 32n === 0xffffn;
}

/**
 * True when the bare address `ip` falls inside the CIDR `cidr`. A bare
 * address (no slash) in the list is an exact /32 or /128 match. An
 * IPv4-mapped IPv6 address can match an IPv4 subnet, and vice versa.
 *
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
function ipMatchesCidr(ip, cidr) {
  const slash = cidr.lastIndexOf('/');
  const network = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefix = slash === -1 ? null : Number(cidr.slice(slash + 1));

  const networkIp = parseIp(network);
  const address = parseIp(ip);
  if (!networkIp || !address) return false;

  let net = networkIp;
  let addr = address;
  if (net.kind !== addr.kind) {
    if (addr.kind === 6 && isIpv4Mapped(addr.value)) {
      addr = { kind: 4, value: addr.value & 0xffffffffn };
    } else if (net.kind === 6 && isIpv4Mapped(net.value)) {
      net = { kind: 4, value: net.value & 0xffffffffn };
    } else {
      return false;
    }
  }

  const bits = net.kind === 6 ? 128 : 32;
  if (prefix === null) {
    return addr.value === net.value;
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (BigInt(bits) - BigInt(prefix));
  return (addr.value & mask) === (net.value & mask);
}

/**
 * Compiles a TRUST_PROXY list into a matcher function `(ip) => boolean`.
 * Entries are bare IPs, CIDRs, or Express preset names. An invalid entry
 * throws, so a typo fails at boot — where a restart fixes it — instead of
 * silently matching nothing on every request.
 *
 * @param {Array<string>} trust
 * @returns {(ip: string) => boolean}
 */
function compileTrustList(trust) {
  const cidrs = [];
  for (const entry of trust) {
    const preset = NET_PRESETS[entry];
    if (preset) {
      cidrs.push(...preset);
      continue;
    }
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`TRUST_PROXY list entries must be IPs, CIDRs, or presets — got "${entry}".`);
    }
    const cidr = entry.trim();
    const slash = cidr.lastIndexOf('/');
    const network = slash === -1 ? cidr : cidr.slice(0, slash);
    const networkKind = net.isIP(network);
    if (networkKind === 0) {
      throw new Error(`TRUST_PROXY list entries must be IPs, CIDRs, or presets — got "${entry}".`);
    }
    if (slash !== -1) {
      const prefix = Number(cidr.slice(slash + 1));
      const max = networkKind === 6 ? 128 : 32;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
        throw new Error(
          `TRUST_PROXY list entries must be IPs, CIDRs, or presets — got "${entry}".`,
        );
      }
    }
    cidrs.push(cidr);
  }
  const matchers = cidrs.map(cidr => ip => ipMatchesCidr(ip, cidr));
  return ip => typeof ip === 'string' && matchers.some(match => match(ip));
}

/**
 * Parses an X-Forwarded-For header value into its entries, left to right.
 * Entries are trimmed and empties dropped; validity is NOT enforced here —
 * an entry that is not an IP simply never matches the trust list, so the
 * walk stops at it, which is where a spoofed chain ends anyway.
 *
 * @param {unknown} raw - the raw header value
 * @returns {Array<string>}
 */
export function parseForwardedFor(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

/**
 * True when `ip` is one of Cloudflare's published anycast addresses. An
 * IPv4 connection arriving on a dual-stack socket reports as ::ffff:a.b.c.d
 * and is matched against the IPv4 ranges.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isCloudflareIp(ip) {
  if (typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  const kind = net.isIP(trimmed);
  if (kind === 0) return false;
  const ranges =
    kind === 4 || (kind === 6 && isIpv4Mapped(parseIp(trimmed).value))
      ? CLOUDFLARE_IPV4_RANGES
      : CLOUDFLARE_IPV6_RANGES;
  return ranges.some(cidr => ipMatchesCidr(trimmed, cidr));
}

/**
 * Resolves the client IP for a request under a given trust setting.
 *
 * @param {object} req - the Fastify request; reads `req.headers` and
 *   `req.socket.remoteAddress`
 * @param {undefined|number|Array<string>|Function} trust - the TRUST_PROXY
 *   value: undefined (trust nothing), a hop count, a proxy list, or a
 *   compiled matcher from compileTrustList
 * @returns {string|undefined} the client address, or the socket peer when
 *   no forwarding header is trusted
 */
export function resolveClientIp(req, trust) {
  const peer = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;
  const headers = req?.headers ?? {};

  // Cloudflare: the edge writes CF-Connecting-IP, so it is authentic
  // exactly when the TCP peer is a Cloudflare address. That check is the
  // trust boundary — no TRUST_PROXY setting is needed to honor it, and none
  // can make a non-Cloudflare peer's copy of the header trustworthy.
  if (peer !== undefined && isCloudflareIp(peer)) {
    const cfConnecting = headers['cf-connecting-ip'];
    if (typeof cfConnecting === 'string') {
      const candidate = cfConnecting.trim();
      if (net.isIP(candidate) !== 0) return candidate;
    }
  }

  const forwarded = parseForwardedFor(headers['x-forwarded-for']);

  if (trust === undefined || trust === null || trust === false || trust === true) {
    // No proxy trust (or trust-everything, which src/config.js rejects at
    // boot): the only authenticated address is the TCP peer.
    return peer;
  }

  if (typeof trust === 'number') {
    const hops = Math.max(0, Math.floor(trust));
    const chain = [...forwarded, peer];
    const boundary = chain.length - 1 - hops;
    // The peer counts as the first trusted hop; the client IP is the entry
    // immediately left of the boundary. When the configured hop count
    // reaches past the leftmost entry the chain is shorter than the
    // operator's trust claim — fail closed to the peer instead of
    // believing a client-written leftmost entry.
    return boundary < 0 ? peer : (chain[boundary] ?? peer);
  }

  // Proxy list: walk from the peer through the XFF entries right to left,
  // skipping entries the list trusts. The first non-matching entry is the
  // client IP; an untrusted peer discards the header outright.
  const isTrusted = typeof trust === 'function' ? trust : compileTrustList(trust);
  const chain = [peer, ...forwarded.reverse()];
  for (const entry of chain) {
    if (isTrusted(entry)) continue;
    return entry ?? peer;
  }
  // Every entry matched the trust list: the leftmost XFF entry is the
  // claimed client, vouched for by the whole trusted chain.
  return chain[chain.length - 1] ?? peer;
}

/**
 * Builds the Fastify onRequest hook that resolves `req.ip` once, before any
 * handler — and before the IP pseudonymiser in src/app.js — reads it.
 *
 * The hook is installed unconditionally: with no trust configured and a
 * non-Cloudflare peer it is a no-op, and the Cloudflare path is
 * trust-independent by design.
 *
 * @param {undefined|number|Array<string>} trust - the TRUST_PROXY value
 * @returns {(req: object) => Promise<void>}
 */
export function createTrustProxyHook(trust) {
  // Compile once at boot: a typo in the list fails here, at startup, rather
  // than as a per-request 500.
  const compiled = Array.isArray(trust) ? compileTrustList(trust) : null;
  return async req => {
    const ip = resolveClientIp(req, compiled ?? trust);
    if (ip !== undefined && ip !== req.ip) {
      Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    }
  };
}
