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
 * Value-level redaction (#411), applied to every string that is about to be
 * logged. Key-name rules cannot see a Stellar seed pasted into a free-text
 * field, so these patterns scan the value itself:
 *
 *   - Stellar ed25519 secret seeds (S followed by 55 base32 characters)
 *   - `Bearer <token>` authorization values
 *   - `password=` / `password: ` fragments
 *   - payment card numbers, confirmed by the Luhn checksum so ordinary digit
 *     strings (amounts, stroops, timestamps) are left alone
 */
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PASSWORD_RE = /(\b(?:password|passwd|pwd)\b\s*[:=]\s*)("?)([^\s",;}]+)/gi;
const PAN_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const REDACTED = '[REDACTED]';

/** Luhn checksum: true for a syntactically valid payment card number. */
function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactString(value) {
  let out = value.replace(STELLAR_SECRET_RE, REDACTED);
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(PASSWORD_RE, (_match, prefix, quote) => `${prefix}${quote}${REDACTED}`);
  out = out.replace(PAN_RE, match => {
    const digits = match.replace(/\D/g, '');
    return passesLuhn(digits) ? REDACTED : match;
  });
  return out;
}

/**
 * Deep-clones a plain object, masking sensitive keys as '***' and scanning
 * every remaining string for secrets/PII. Safe to call on headers, query
 * params, or any plain object before it reaches console.*.
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
  if (typeof value === 'string') return redactString(value);
  return value;
}
