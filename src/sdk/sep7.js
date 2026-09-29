import { StrKey } from '@stellar/stellar-sdk';
import { validateAmount, STELLAR_DECIMALS } from './validation.js';

/**
 * SEP-0007 `web+stellar:pay` URI generation and strict parsing (#424).
 *
 * Wallets act on these URIs (QR codes, deep links), so the parser errs on the
 * side of refusing: a malformed or ambiguous URI is rejected with every
 * problem listed, never partly interpreted. Specifically rejected:
 *
 *  - duplicate, empty or value-less query parameters and unknown parameters;
 *  - malformed percent-encoding, and a raw `+` (form-encoding would read it as
 *    a space, so its meaning is ambiguous — SEP-0007 uses `%20` and `%2B`);
 *  - an amount that is negative or carries more than 7 decimals (silently
 *    truncating a payment amount is not acceptable here);
 *  - an asset code without an issuer (or the reverse), and a memo without its
 *    type (or the reverse).
 *
 * Only the `pay` operation is supported. `signature` is checked for shape but
 * NOT cryptographically verified: that needs the domain's stellar.toml
 * `URI_REQUEST_SIGNING_KEY`, so a parsed `originDomain` must not be trusted as
 * authentic unless the caller verifies the signature itself.
 */

export const SEP7_SCHEME = 'web+stellar:';
export const MEMO_TYPES = ['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN'];

const MAX_URI_LENGTH = 8192;
const MAX_MSG_LENGTH = 300;
const MAX_MEMO_TEXT_BYTES = 28;
const MAX_UINT64 = 18446744073709551615n;

/** Query parameter name → property name, in canonical (spec example) order. */
const PARAMS = {
  destination: 'destination',
  amount: 'amount',
  asset_code: 'assetCode',
  asset_issuer: 'assetIssuer',
  memo: 'memo',
  memo_type: 'memoType',
  callback: 'callback',
  msg: 'msg',
  network_passphrase: 'networkPassphrase',
  origin_domain: 'originDomain',
  signature: 'signature',
};

const FEDERATION_ADDRESS_RE = /^[^*\s]+\*[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FQDN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export class Sep7Error extends Error {
  constructor(errors) {
    super(`Invalid SEP-0007 URI:\n - ${errors.join('\n - ')}`);
    this.name = 'Sep7Error';
    this.errors = errors;
  }
}

function isValidDestination(value) {
  return (
    StrKey.isValidEd25519PublicKey(value) ||
    StrKey.isValidMed25519PublicKey(value) ||
    StrKey.isValidContract(value) ||
    FEDERATION_ADDRESS_RE.test(value)
  );
}

function isBase64Bytes(value, length) {
  return BASE64_RE.test(value) && Buffer.from(value, 'base64').length === length;
}

/**
 * The single rule set, applied to parsed OR caller-supplied values so that a
 * URI we generate is always one we would accept.
 * @returns {string[]} error messages (empty when valid)
 */
function validateParams(p) {
  const errors = [];
  if (!p.destination) errors.push('destination is required');
  else if (!isValidDestination(p.destination)) {
    errors.push(`destination "${p.destination}" is not a valid account, contract or address`);
  }

  if (p.amount !== undefined) {
    errors.push(...validateAmount(p.amount).map(e => e.replace('pricing.amount', 'amount')));
    if (typeof p.amount === 'string' && (p.amount.split('.')[1] ?? '').length > STELLAR_DECIMALS) {
      errors.push(`amount "${p.amount}" has more than ${STELLAR_DECIMALS} decimal places`);
    }
  }

  if ((p.assetCode === undefined) !== (p.assetIssuer === undefined)) {
    errors.push('asset_code and asset_issuer must be given together (omit both for XLM)');
  }
  if (p.assetCode !== undefined && !ASSET_CODE_RE.test(p.assetCode)) {
    errors.push('asset_code must be 1-12 alphanumeric characters');
  }
  if (p.assetIssuer !== undefined && !StrKey.isValidEd25519PublicKey(p.assetIssuer)) {
    errors.push('asset_issuer must be a valid account ID');
  }

  if ((p.memo === undefined) !== (p.memoType === undefined)) {
    errors.push('memo and memo_type must be given together');
  } else if (p.memoType !== undefined) {
    errors.push(...validateMemo(p.memoType, String(p.memo)));
  }

  if (p.callback !== undefined) {
    let url = null;
    if (p.callback.startsWith('url:')) {
      try {
        url = new URL(p.callback.slice(4));
      } catch {
        /* reported below */
      }
    }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      errors.push('callback must be "url:" followed by an absolute http(s) URL');
    }
  }
  if (p.msg !== undefined && p.msg.length > MAX_MSG_LENGTH) {
    errors.push(`msg must not exceed ${MAX_MSG_LENGTH} characters`);
  }
  if (p.networkPassphrase !== undefined && p.networkPassphrase.trim() === '') {
    errors.push('network_passphrase must not be empty');
  }
  if (p.originDomain !== undefined && !FQDN_RE.test(p.originDomain)) {
    errors.push('origin_domain must be a fully qualified domain name');
  }
  if (p.signature !== undefined) {
    if (p.originDomain === undefined) errors.push('signature requires origin_domain');
    if (!isBase64Bytes(p.signature, 64)) errors.push('signature must be base64 of 64 bytes');
  }
  return errors;
}

function validateMemo(type, memo) {
  if (!MEMO_TYPES.includes(type)) return [`memo_type must be one of ${MEMO_TYPES.join(', ')}`];
  if (type === 'MEMO_TEXT') {
    return Buffer.byteLength(memo, 'utf8') > MAX_MEMO_TEXT_BYTES
      ? [`MEMO_TEXT must not exceed ${MAX_MEMO_TEXT_BYTES} bytes`]
      : [];
  }
  if (type === 'MEMO_ID') {
    return /^\d+$/.test(memo) && BigInt(memo) <= MAX_UINT64
      ? []
      : ['MEMO_ID must be an unsigned 64-bit integer'];
  }
  return isBase64Bytes(memo, 32) ? [] : [`${type} must be base64 of exactly 32 bytes`];
}

/**
 * Parses a SEP-0007 `pay` URI.
 *
 * @param {string} uri
 * @returns {{destination: string, amount?: string, assetCode?: string,
 *   assetIssuer?: string, memo?: string, memoType?: string, callback?: string,
 *   msg?: string, networkPassphrase?: string, originDomain?: string,
 *   signature?: string}} only the parameters present in the URI
 * @throws {Sep7Error} listing every problem found
 */
export function parsePayUri(uri) {
  if (typeof uri !== 'string' || uri === '')
    throw new Sep7Error(['URI must be a non-empty string']);
  if (uri.length > MAX_URI_LENGTH)
    throw new Sep7Error([`URI exceeds ${MAX_URI_LENGTH} characters`]);
  if (uri.slice(0, SEP7_SCHEME.length).toLowerCase() !== SEP7_SCHEME) {
    throw new Sep7Error([`URI must start with "${SEP7_SCHEME}"`]);
  }

  const rest = uri.slice(SEP7_SCHEME.length);
  const q = rest.indexOf('?');
  const operation = q === -1 ? rest : rest.slice(0, q);
  if (operation !== 'pay') {
    throw new Sep7Error([
      operation === '' || operation.startsWith('/')
        ? 'URI must be web+stellar:<operation>?... with no "//"'
        : `unsupported operation "${operation}" (only "pay" is supported)`,
    ]);
  }
  if (q === -1 || q === rest.length - 1) throw new Sep7Error(['pay URI has no query parameters']);
  if (uri.includes('#')) throw new Sep7Error(['URI must not contain a fragment']);

  const errors = [];
  const params = {};
  for (const pair of rest.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (pair === '' || eq <= 0) {
      errors.push(`malformed query parameter "${pair}"`);
      continue;
    }
    const key = pair.slice(0, eq);
    const rawValue = pair.slice(eq + 1);
    const prop = Object.hasOwn(PARAMS, key) ? PARAMS[key] : undefined;
    if (!prop) {
      errors.push(`unknown parameter "${key}"`);
      continue;
    }
    if (Object.hasOwn(params, prop)) {
      errors.push(`duplicate parameter "${key}"`);
      continue;
    }
    if (rawValue === '') {
      errors.push(`parameter "${key}" has an empty value`);
      continue;
    }
    if (rawValue.includes('+')) {
      errors.push(`parameter "${key}" contains an unencoded "+" (use %20 or %2B)`);
      continue;
    }
    try {
      params[prop] = decodeURIComponent(rawValue);
    } catch {
      errors.push(`parameter "${key}" has malformed percent-encoding`);
    }
  }

  errors.push(...validateParams(params));
  if (errors.length > 0) throw new Sep7Error(errors);
  return params;
}

/**
 * Builds a SEP-0007 `pay` URI, validating with the same rules as the parser.
 * Parameters are emitted in the spec's canonical order, so
 * `buildPayUri(parsePayUri(uri)) === uri` for any URI the parser accepts.
 *
 * @param {object} params - as returned by parsePayUri
 * @throws {Sep7Error}
 */
export function buildPayUri(params) {
  const unknown = Object.keys(params).filter(k => !Object.values(PARAMS).includes(k));
  const errors = [...unknown.map(k => `unknown parameter "${k}"`), ...validateParams(params)];
  if (errors.length > 0) throw new Sep7Error(errors);
  const query = Object.entries(PARAMS)
    .filter(([, prop]) => params[prop] !== undefined)
    .map(([key, prop]) => `${key}=${encodeURIComponent(String(params[prop]))}`);
  return `${SEP7_SCHEME}pay?${query.join('&')}`;
}

/**
 * Builds a pay URI from an x402 payment request. `payTo` is the destination
 * and `amount` (a stroop count, as x402 carries it) becomes SEP-0007's decimal
 * amount. x402 identifies a Stellar asset by contract ID, which does not carry
 * the classic code/issuer SEP-0007 needs, so those are passed in `extra`
 * (omit both to request XLM).
 *
 * @param {{payTo: string, amount?: string|bigint}} requirements
 * @param {object} [extra] - assetCode, assetIssuer, memo, memoType, msg, callback, ...
 */
export function payUriFromRequirements(requirements, extra = {}) {
  const params = { destination: requirements.payTo, ...extra };
  if (requirements.amount !== undefined) {
    const stroops = BigInt(requirements.amount);
    const scale = 10n ** BigInt(STELLAR_DECIMALS);
    const frac = (stroops % scale).toString().padStart(STELLAR_DECIMALS, '0').replace(/0+$/, '');
    params.amount = `${stroops / scale}${frac ? `.${frac}` : ''}`;
  }
  return buildPayUri(params);
}
