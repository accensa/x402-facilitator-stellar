/**
 * Redaction for anything the transport logs.
 *
 * The structured request logger in src/log.js emits a fixed whitelist of fields
 * that cannot carry secret material, so by construction the auth entry, the raw
 * transaction, API keys and the facilitator secret never reach the log. This
 * module is the defence-in-depth choke point for any object that is ever logged
 * ad hoc: redact() before you log, not per call site. src/log.js runs its line
 * through redact() for exactly that reason.
 *
 * Hand-written rather than pulling in pino: the repo is deliberate about its
 * dependency surface (see #68's reasoning and the licence-check job in CI), and
 * a redaction rulebook of a handful of key names doesn't need a logging
 * framework — swap console.* for pino later if structured/leveled logging
 * becomes a real need, and reuse REDACTED_KEY_NAMES / redact() as its
 * `redact` option.
 */

const REDACTED_KEY_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return REDACTED_KEY_NAMES.has(lower) || lower.endsWith('_secret') || lower.endsWith('-secret');
}

/**
 * Deep-clones a plain object, masking sensitive keys as '***' and leaving
 * everything else untouched. Safe to call on headers, query params, or any
 * plain object before it reaches console.*.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '***' : redact(val);
    }
    return out;
  }
  return value;
}
