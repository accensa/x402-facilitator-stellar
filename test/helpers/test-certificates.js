/**
 * A throwaway X.509 builder, used only by this test file.
 *
 * Node can PARSE certificates (`crypto.X509Certificate`) and sign with a key
 * (`crypto.sign`), but it cannot ISSUE one — there is no certificate-generation
 * API. The mTLS tests need a receiver that really demands a client certificate
 * and really rejects an untrusted one, which means a genuine handshake rather
 * than a mocked `fetch`. So this module encodes the small slice of ASN.1 DER
 * that a self-signed CA and the two leaf certificates it signs require, using
 * nothing but `node:crypto`.
 *
 * Scope is deliberately minimal: P-256 keys, SHA-256 signatures, UTCTime
 * validity, and only the extensions the tests need (basicConstraints, keyUsage,
 * extendedKeyUsage, subjectAltName). It is test scaffolding, not a CA library,
 * and it is not exported for production use.
 */

import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';

// --- DER primitives ---------------------------------------------------------

/** Encodes a DER length: short form under 128, otherwise long form. */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Wraps `parts` in a DER TLV with the given tag byte. */
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

/** Encodes OID arcs: the first two collapse into one byte, the rest are base-128. */
function oidBytes(arcs) {
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [];
    let v = arc;
    do {
      stack.unshift(v % 128);
      v = Math.floor(v / 128);
    } while (v > 0);
    // Every byte but the last carries the continuation bit.
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    out.push(...stack);
  }
  return Buffer.from(out);
}

const OID = (...arcs) => der(0x06, oidBytes(arcs));
const NULL = Buffer.from([0x05, 0x00]);
/**
 * DER INTEGER, canonicalizing an unsigned big-endian byte string to the
 * minimal encoding X.690 requires: any redundant leading 0x00 is stripped,
 * and exactly one is (re)inserted if the high bit would otherwise flip the
 * sign. Without this, a randomly generated value (e.g. a certificate serial
 * number) is invalid DER whenever its leading byte happens to need padding
 * removed or added — OpenSSL then refuses to parse the certificate at all
 * with `ERR_OSSL_ASN1_ILLEGAL_PADDING`, intermittently and only for the
 * unlucky byte values (#473 CI flake).
 */
function INTEGER(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00 && (bytes[start + 1] & 0x80) === 0) {
    start++;
  }
  let b = bytes.subarray(start);
  if (b.length === 0) b = Buffer.from([0x00]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return der(0x02, b);
}
/** BIT STRING with zero unused trailing bits. */
const BIT_STRING = bytes => der(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
const OCTET_STRING = bytes => der(0x04, bytes);
const UTF8_STRING = s => der(0x0c, Buffer.from(s, 'utf8'));
const BOOLEAN = b => der(0x01, Buffer.from([b ? 0xff : 0x00]));
/** Context-specific constructed tag [n]. */
const CONTEXT = (n, ...parts) => der(0xa0 | n, ...parts);

const pad2 = n => String(n).padStart(2, '0');

/** UTCTime (YYMMDDHHMMSSZ), valid until 2049 — comfortably past any test. */
const UTC_TIME = date =>
  der(
    0x17,
    Buffer.from(
      `${pad2(date.getUTCFullYear() % 100)}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
        `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`,
      'ascii',
    ),
  );

/** ecdsa-with-SHA256, with the absent parameters encoded as an explicit NULL. */
const ECDSA_SHA256 = der(0x30, OID(1, 2, 840, 10045, 4, 3, 2), NULL);

/** A single-RDN Name carrying only a commonName. */
const commonName = cn => der(0x30, der(0x31, der(0x30, OID(2, 5, 4, 3), UTF8_STRING(cn))));

/** Wraps DER bytes in PEM armour, 64 characters per line. */
function toPem(der) {
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// --- Certificate issuance ---------------------------------------------------

/** Generates a P-256 key pair in the form the TLS layer wants as PEM. */
export function generateKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/**
 * Issues one certificate.
 *
 * @param {object} params
 * @param {string} params.subject - commonName of the subject
 * @param {string} params.issuer - commonName of the issuer (the CA's subject)
 * @param {KeyObject} params.keys - the subject's key pair
 * @param {KeyObject} params.issuerKeys - the signing CA's key pair
 * @param {boolean} [params.isCa] - marks the certificate as a CA (keyCertSign)
 * @param {boolean} [params.clientAuth] - adds the clientAuth EKU
 * @param {boolean} [params.serverAuth] - adds the serverAuth EKU
 * @param {string[]} [params.subjectAltNames] - DNS names, or `ip:a.b.c.d`
 * @param {number} [params.validDays] - lifetime from `notBefore`
 * @param {Date} [params.notBefore] - backdated slightly so clock skew cannot bite
 * @returns {{cert: string, key: string}} the certificate and its private key, PEM
 */
export function issueCertificate({
  subject,
  issuer,
  keys,
  issuerKeys,
  isCa = false,
  clientAuth = false,
  serverAuth = false,
  subjectAltNames = [],
  validDays = 365,
  notBefore = new Date(Date.now() - 60_000),
}) {
  const extensions = [];
  // basicConstraints — a CA must assert CA:TRUE or OpenSSL will not let it sign.
  extensions.push(
    der(
      0x30,
      OID(2, 5, 29, 19),
      BOOLEAN(true),
      OCTET_STRING(der(0x30, isCa ? BOOLEAN(true) : Buffer.alloc(0))),
    ),
  );
  // keyUsage — bit 0 (digitalSignature) for leaves, bit 5 (keyCertSign) for CAs.
  extensions.push(
    der(
      0x30,
      OID(2, 5, 29, 15),
      BOOLEAN(true),
      OCTET_STRING(
        isCa ? der(0x03, Buffer.from([0x02, 0x04])) : der(0x03, Buffer.from([0x07, 0x80])),
      ),
    ),
  );
  if (clientAuth || serverAuth) {
    const usages = [];
    if (serverAuth) usages.push(OID(1, 3, 6, 1, 5, 5, 7, 3, 1));
    if (clientAuth) usages.push(OID(1, 3, 6, 1, 5, 5, 7, 3, 2));
    extensions.push(der(0x30, OID(2, 5, 29, 37), OCTET_STRING(der(0x30, ...usages))));
  }
  // subjectAltName — a SAN is what modern TLS requires; a bare CN is ignored,
  // which is what makes a hand-rolled cert fail hostname verification.
  if (subjectAltNames.length) {
    const names = subjectAltNames.flatMap(name =>
      name.startsWith('ip:')
        ? [der(0x87, Buffer.from(name.slice(3).split('.').map(Number)))]
        : [der(0x82, Buffer.from(name, 'ascii'))],
    );
    extensions.push(der(0x30, OID(2, 5, 29, 17), OCTET_STRING(der(0x30, ...names))));
  }

  // A positive serial (high bit cleared) so no consumer treats it as negative.
  const serial = randomBytes(16);
  serial[0] &= 0x7f;

  const tbsCertificate = der(
    0x30,
    CONTEXT(0, INTEGER(Buffer.from([0x02]))), // version v3
    INTEGER(serial),
    ECDSA_SHA256,
    commonName(issuer),
    der(
      0x30,
      UTC_TIME(notBefore),
      UTC_TIME(new Date(notBefore.getTime() + validDays * 86_400_000)),
    ),
    commonName(subject),
    keys.publicKey.export({ type: 'spki', format: 'der' }),
    CONTEXT(3, der(0x30, ...extensions)),
  );

  const signature = sign('sha256', tbsCertificate, issuerKeys.privateKey);
  return {
    cert: toPem(der(0x30, tbsCertificate, ECDSA_SHA256, BIT_STRING(signature))),
    key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Builds a self-signed CA plus a server and a client certificate it signed.
 *
 * The client certificate carries the clientAuth EKU and the server one carries
 * serverAuth — without the matching EKU, OpenSSL refuses the peer even when the
 * chain is valid, which would make these tests pass for the wrong reason.
 *
 * @param {object} [options]
 * @param {string[]} [options.serverAltNames] - names/ips the server answers on
 * @param {number} [options.clientValidDays] - used to test an expiring client cert
 * @returns {{ca: object, server: object, client: object}}
 */
export function createCertificateAuthority({
  serverAltNames = ['localhost', '127.0.0.1'],
  clientValidDays = 365,
} = {}) {
  const caKeys = generateKeyPair();
  const serverKeys = generateKeyPair();
  const clientKeys = generateKeyPair();

  return {
    ca: issueCertificate({
      subject: 'x402-facilitator test CA',
      issuer: 'x402-facilitator test CA',
      keys: caKeys,
      issuerKeys: caKeys,
      isCa: true,
    }),
    server: issueCertificate({
      subject: 'localhost',
      issuer: 'x402-facilitator test CA',
      keys: serverKeys,
      issuerKeys: caKeys,
      serverAuth: true,
      subjectAltNames: serverAltNames,
    }),
    client: issueCertificate({
      subject: 'x402-facilitator test merchant',
      issuer: 'x402-facilitator test CA',
      keys: clientKeys,
      issuerKeys: caKeys,
      clientAuth: true,
      validDays: clientValidDays,
    }),
  };
}
