/**
 * Makes Soroban RPC reachable from Node, retries connection-level failures,
 * and opens a per-host circuit breaker when the endpoint is genuinely down.
 *
 * `@stellar/stellar-sdk` reaches Soroban RPC through the global `fetch`, so
 * wrapping it here covers every RPC call the scheme makes — simulate, send and
 * poll — without reaching inside `ExactStellarScheme`.
 *
 * WHY THIS EXISTS — three distinct problems, one wrapper.
 *
 * 1. IPv6 dead-ends. `soroban-testnet.stellar.org` advertises AAAA records
 *    (Cloudflare). On an IPv4-only host those addresses fail with ENETUNREACH,
 *    and Node's built-in fetch does not reliably fall back to the A records —
 *    every request times out, while `curl` to the same host succeeds every
 *    time because it falls back immediately. Forcing `family: 4` on the
 *    connector removes the dead path. This is not exotic: any machine without
 *    working IPv6 hits it, which makes it a self-hosting footgun worth handling
 *    in the code rather than in a troubleshooting note.
 *
 * 2. Transient timeouts on top of that, retried below.
 *
 * 3. Sustained outages (issue #105). Retrying is right for a transient failure
 *    and wrong for a sustained one: against a dead endpoint every request pays
 *    the full retry budget (~12s), concurrent requests pile up behind it, and
 *    the retries add load to something already failing. The breaker below
 *    fails fast instead of re-dialling.
 *
 * WHAT IS AND IS NOT RETRIED — AND WHAT MAY OPEN THE BREAKER. Only failures
 * raised *before* a response is received — connection timeouts and resets, the
 * RETRYABLE set below. Once the server has answered, whatever it said stands:
 * an RPC error, a rejected simulation or a failed settlement is returned
 * unchanged, retried by nothing, and counted by nothing here. Breaking on a
 * received response would convert a real failure into a flaky success, which
 * is precisely the class of bug this repo exists to avoid. The RETRYABLE set
 * is therefore both retry trigger and breaker trigger — one line, drawn once.
 *
 * ON RESUBMISSION SAFETY. A retry can in principle resend `sendTransaction`.
 * That is safe here for two reasons: a connection-level failure means the
 * request most likely never arrived, and a Soroban transaction is identified by
 * its hash, so a genuine duplicate is rejected as such by the network rather
 * than settling twice. At the HTTP level, issue #10 introduces durable
 * idempotency keys (`settlements` table) to deduplicate incoming requests and
 * record status across restarts.
 *
 * ON sendTransaction AND THE BREAKER. A settle whose broadcast has already
 * gone out must never be reported as failed because a breaker tripped
 * underneath it — the transaction may well land on chain. So calls carrying a
 * sendTransaction body are never fast-failed by an open breaker; they always
 * get their dial. This makes them the one request class that pays the retry
 * budget during an outage, which is the correct trade: a wrong "settle failed"
 * costs a caller money twice over, while one slow failure costs seconds.
 */

import { createRequire } from 'node:module';
import { requestState } from './request-state.js';

const require = createRequire(import.meta.url);

const RETRYABLE = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Thrown without dialling when a host's breaker is open. Carries a distinct
 * code so route handlers can return a specific reason code — a caller must be
 * able to tell "the chain is unreachable" from "your payment was rejected".
 */
export class RpcBreakerOpenError extends Error {
  constructor(host) {
    super(`soroban rpc ${host} is unreachable (circuit open)`);
    this.name = 'RpcBreakerOpenError';
    this.code = 'RPC_BREAKER_OPEN';
    this.host = host;
  }
}

/** Host key for breaker state: scheme+host+port, so two ports break apart. */
function hostOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : (input?.url ?? '')).origin;
  } catch {
    return '(unparsable)';
  }
}

/**
 * Reads whether a request carries a sendTransaction — the one call that must
 * not be aborted mid-flight or fast-failed while its broadcast may be live.
 */
function isSendTransaction(input, init) {
  const body = init?.body ?? (typeof input !== 'string' ? input?.body : undefined);
  if (typeof body !== 'string') return false;
  return body.includes('"sendTransaction"');
}

/**
 * Installs the retrying, breaker-aware wrapper over the global fetch.
 *
 * @param {object} [options]
 * @param {number} [options.attempts] - total attempts including the first
 * @param {number} [options.baseDelayMs] - linear backoff step
 * @param {number} [options.threshold] - consecutive connection failures per
 *   host before the breaker opens. Deliberately high default: opening too
 *   eagerly on a slow-but-working RPC is worse than a few slow failures.
 * @param {number} [options.cooldownMs] - how long an open breaker waits before
 *   letting a single probe through (half-open)
 * @param {(msg: string) => void} [options.log]
 * @param {(msg: string) => void} [options.onStateChange]
 * @param {(info: { code: string|undefined, attempt: number, host: string, url: string }) => void} [options.onRetry]
 *   structured hook for observability — feeds x402_rpc_retries_total from the
 *   metrics layer rather than parsing a log string.
 * @returns {{ getBreakerStates: Function }} readable breaker state, surfaced
 *   on the readiness endpoint (issue #100)
 */
export function installRpcRetry({
  attempts = 5,
  baseDelayMs = 800,
  threshold = Number(process.env.RPC_BREAKER_THRESHOLD ?? 10),
  cooldownMs = Number(process.env.RPC_BREAKER_COOLDOWN_MS ?? 30_000),
  log = () => {},
  onStateChange = () => {},
  onRetry = () => {},
  forceIpv4 = process.env.RPC_FORCE_IPV4 !== 'false',
} = {}) {
  const builtinFetch = globalThis.fetch;

  // undici's fetch is used rather than the built-in one because only the former
  // accepts a dispatcher. Note the npm `undici` and Node's bundled copy are
  // separate module instances, so `setGlobalDispatcher` from the package does
  // NOT affect `globalThis.fetch` — the dispatcher has to travel with the call.
  let call = builtinFetch;
  if (forceIpv4) {
    const { Agent, fetch: undiciFetch } = require('undici');
    const agent = new Agent({ connect: { family: 4 } });
    call = (input, init) => undiciFetch(input, { ...init, dispatcher: agent });
  }

  /** host -> breaker state machine */
  const breakers = new Map();

  function breakerFor(host) {
    let b = breakers.get(host);
    if (!b) {
      b = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: 0,
        probeInFlight: false,
      };
      breakers.set(host, b);
    }
    return b;
  }

  function transition(b, host, state) {
    b.state = state;
    onStateChange(`breaker ${state} for ${host}`);
  }

  function recordFailure(b, host) {
    b.consecutiveFailures++;
    if (b.state === 'half-open' || b.consecutiveFailures >= threshold) {
      if (b.state !== 'open') {
        b.openedAt = Date.now();
        transition(b, host, 'open');
        log(`rpc breaker OPEN for ${host} after ${b.consecutiveFailures} consecutive failures`);
      }
    }
  }

  function recordSuccess(b, host) {
    if (b.state !== 'closed') {
      transition(b, host, 'closed');
      log(`rpc breaker CLOSED for ${host}`);
    }
    b.consecutiveFailures = 0;
    b.probeInFlight = false;
  }

  /**
   * Gate run before each dial. Returns true if the call may proceed.
   * sendTransaction calls bypass this entirely — see the header note.
   */
  function gate(b, host) {
    if (b.state === 'open') {
      if (Date.now() - b.openedAt < cooldownMs) return false;
      // Cooldown elapsed: this call becomes the single half-open probe, and
      // must proceed — returning true here before the probeInFlight check
      // below, which exists to refuse everyone ELSE while the probe runs.
      transition(b, host, 'half-open');
      b.probeInFlight = true;
      return true;
    }
    if (b.state === 'half-open' && b.probeInFlight) return false;
    return true;
  }

  globalThis.fetch = async function retryingFetch(input, init) {
    const host = hostOf(input);
    const b = breakerFor(host);
    // Computed once, up front: whether this invocation is protected from the
    // breaker. A settle whose broadcast went out must ride out a trip that
    // happens between its own retries.
    const protectedCall = isSendTransaction(input, init);
    if (protectedCall) {
      const store = requestState.getStore();
      if (store) {
        store.submitted = true;
      }
    }

    if (!protectedCall && !gate(b, host)) {
      throw new RpcBreakerOpenError(host);
    }

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await call(input, init);
        recordSuccess(b, host);
        return res;
      } catch (err) {
        const code = err?.cause?.code ?? err?.code;
        if (!RETRYABLE.has(code) || attempt === attempts) {
          lastError = err;
          break;
        }
        lastError = err;
        recordFailure(b, host);
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        log(`rpc ${code} on ${url} — retry ${attempt}/${attempts - 1}`);
        onRetry({ code, attempt, host, url });
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      }
    }
    // The final failure of the loop also counts toward the breaker: it is as
    // real a connection failure as the intermediate ones, it just arrives
    // without another retry after it.
    const code = lastError?.cause?.code ?? lastError?.code;
    if (RETRYABLE.has(code)) recordFailure(b, host);
    throw lastError;
  };

  /**
   * Breaker snapshot for observability — consumed by GET /health/ready so an
   * orchestrator can see "the dependency is down" without parsing logs.
   */
  function getBreakerStates() {
    const out = {};
    for (const [host, b] of breakers.entries()) {
      out[host] = {
        state: b.state,
        consecutive_failures: b.consecutiveFailures,
        opened_at: b.state === 'open' ? new Date(b.openedAt).toISOString() : null,
      };
    }
    return out;
  }

  return { getBreakerStates };
}
