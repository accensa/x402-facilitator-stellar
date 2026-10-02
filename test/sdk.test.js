import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toStroops,
  validateDiscoveryDeclaration,
  createStellarDiscoveryResource,
  parsePayUri,
  buildPayUri,
  payUriFromRequirements,
  Sep7Error,
} from '../src/sdk/index.js';
import { StrKey } from '@stellar/stellar-sdk';

const validDeclaration = {
  routeTemplate: '/api/data/{id}',
  parameters: { id: 'The data ID' },
  pricing: { amount: '1', asset: 'USDC' },
};

test('toStroops converts decimal strings to stroops', () => {
  assert.equal(toStroops('1'), '10000000');
  assert.equal(toStroops('0.5'), '5000000');
  assert.equal(toStroops('10.1234567'), '101234567');
  assert.equal(toStroops('0.0000001'), '1');
  assert.equal(toStroops('123.456'), '1234560000');
  // Exactly 7 decimals is the representable limit — must not throw.
  assert.equal(toStroops('1.1234567'), '11234567');
  // No decimal point.
  assert.equal(toStroops('42'), '420000000');
  // A leading + is a valid decimal numeric string.
  assert.equal(toStroops('+1.5'), '15000000');
  // Zero is a valid price by policy, and it flows through conversion.
  assert.equal(toStroops('0'), '0');
  // BigInt is an exact stroop count already.
  assert.equal(toStroops(1234567n), '1234567');
  // Far beyond Number.MAX_SAFE_INTEGER — the arithmetic is BigInt, so it works.
  assert.equal(
    toStroops('123456789012345678901234567890.5'),
    '1234567890123456789012345678905000000',
  );
});

test('toStroops truncates beyond 7 decimals rather than rounding', () => {
  // Stellar's asset precision is 7 decimals; the 8th digit is dropped, not
  // rounded — rounding would invent stroops that never existed.
  assert.equal(toStroops('1.12345678'), '11234567');
  assert.equal(toStroops('0.00000001'), '0');
  assert.equal(toStroops('9.99999999'), '99999999');
});

test('toStroops rejects non-numeric input with a structured message, not a SyntaxError', () => {
  assert.throws(() => toStroops('abc'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('1e7'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('NaN'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('Infinity'), /not a valid decimal numeric string/);
  // Exponent notation like '1.5e-7' must not be coerced into 15000000 silently.
  assert.throws(() => toStroops('1.5e-7'), /not a valid decimal numeric string/);
});

test('toStroops rejects number inputs (precision already lost)', () => {
  assert.throws(() => toStroops(1), /decimal numeric string/);
  assert.throws(() => toStroops(0), /decimal numeric string/);
  assert.throws(() => toStroops(0.5), /decimal numeric string/);
});

test('toStroops rejects negatives and missing amounts', () => {
  assert.throws(() => toStroops('-1.5'), /must not be negative/);
  assert.throws(() => toStroops(''), /required/);
  assert.throws(() => toStroops(null), /required/);
  assert.throws(() => toStroops(undefined), /required/);
});

test('validateDiscoveryDeclaration rejects a missing amount', () => {
  const errors = validateDiscoveryDeclaration({
    routeTemplate: '/api/data/{id}',
    parameters: { id: 'The data ID' },
    pricing: { asset: 'USDC' },
  });
  assert.ok(errors.includes('pricing.amount is required'));
});

test('validateDiscoveryDeclaration agrees with toStroops on zero', () => {
  // Zero is a valid price — the validator and toStroops must agree.
  const withStringZero = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '0', asset: 'USDC' },
  });
  assert.equal(withStringZero.length, 0);
  assert.equal(toStroops('0'), '0');

  // A number 0 is still a number: rejected on input shape, not on value.
  const withNumberZero = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: 0, asset: 'USDC' },
  });
  assert.ok(withNumberZero.some(e => e.includes('decimal numeric string')));
  assert.throws(() => toStroops(0));
});

test('validateDiscoveryDeclaration rejects non-numeric and over-precise amounts', () => {
  const nonNumeric = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: 'abc', asset: 'USDC' },
  });
  assert.ok(nonNumeric.some(e => e.includes('not a valid decimal numeric string')));

  // Over-precise amounts are accepted at validation and truncated on conversion.
  const overPrecise = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '1.12345678', asset: 'USDC' },
  });
  assert.equal(overPrecise.length, 0);
  assert.equal(toStroops('1.12345678'), '11234567');

  const negative = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '-1', asset: 'USDC' },
  });
  assert.ok(negative.some(e => e.includes('must not be negative')));
});

test('validateDiscoveryDeclaration still reports structural errors', () => {
  const invalid = {
    routeTemplate: '/api/data/{id}',
    pricing: { amount: '1', asset: 'USDC' },
  };
  const errors = validateDiscoveryDeclaration(invalid);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Missing description for parameter: id'));
});

test('createStellarDiscoveryResource converts amounts and fills defaults', () => {
  const res = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '2.5', asset: 'XLM' },
  });
  assert.equal(res.pricing.amount, '25000000');
  assert.equal(res.network, 'stellar:testnet');
  assert.equal(res.scheme, 'exact');
});

test('createStellarDiscoveryResource surfaces the same structured error as other invalid fields', () => {
  // A non-numeric amount must produce the structured declaration error, not a
  // raw BigInt SyntaxError from deep in the conversion.
  assert.throws(
    () =>
      createStellarDiscoveryResource({
        routeTemplate: '/api/ping',
        pricing: { amount: 'abc', asset: 'XLM' },
      }),
    /Invalid discovery declaration:[\s\S]*not a valid decimal numeric string/,
  );

  // Over-precise amounts are truncated, not rejected: '1.12345678' -> 11234567.
  const truncated = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '1.12345678', asset: 'XLM' },
  });
  assert.equal(truncated.pricing.amount, '11234567');

  // Zero is accepted end to end.
  const free = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '0', asset: 'XLM' },
  });
  assert.equal(free.pricing.amount, '0');
});

test('routeTemplate placeholders: empty, malformed, duplicated and inherited names (#226)', () => {
  // An empty placeholder is called out on its own rather than becoming a
  // parameter named ''.
  const empty = validateDiscoveryDeclaration({
    ...validDeclaration,
    routeTemplate: '/x/{ }',
    parameters: {},
  });
  assert.ok(empty.some(e => e.includes('empty parameter placeholder')));

  // Names that are not plain identifiers are rejected outright — a dotted or
  // spaced name is never a real route parameter.
  const malformed = validateDiscoveryDeclaration({
    ...validDeclaration,
    routeTemplate: '/x/{a.b}',
    parameters: {},
  });
  assert.ok(malformed.some(e => e.includes('Invalid routeTemplate parameter name: a.b')));

  // The same parameter twice is one missing description, not two.
  const duplicated = validateDiscoveryDeclaration({
    ...validDeclaration,
    routeTemplate: '/users/{id}/posts/{id}',
    parameters: {},
  });
  assert.equal(
    duplicated.filter(e => e.includes('Missing description for parameter: id')).length,
    1,
  );

  // The bug this guards: `decl.parameters['constructor']` is truthy via
  // Object.prototype even when the seller described nothing, so a plain
  // truthiness check silently accepted it. Object.hasOwn is what fixes it.
  const inherited = validateDiscoveryDeclaration({
    ...validDeclaration,
    routeTemplate: '/x/{constructor}',
    parameters: {},
  });
  assert.ok(inherited.some(e => e.includes('Missing description for parameter: constructor')));

  // A present-but-blank description is not a description.
  const blank = validateDiscoveryDeclaration({
    ...validDeclaration,
    routeTemplate: '/x/{id}',
    parameters: { id: '   ' },
  });
  assert.ok(blank.some(e => e.includes('Missing description for parameter: id')));
});

describe('SEP-0007 pay URI conformance matrix (#424)', () => {
  const DEST = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
  const ISSUER = 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB';
  const B64_32 = Buffer.alloc(32, 7).toString('base64');
  const enc = encodeURIComponent;
  const base = `web+stellar:pay?destination=${DEST}`;

  // Verbatim examples from stellar-protocol ecosystem/sep-0007.md.
  const SDF_VECTORS = [
    {
      name: 'Example 1: payment with lumens',
      uri: `web+stellar:pay?destination=${DEST}&amount=120.1234567&memo=skdjfasf&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens`,
      parsed: {
        destination: DEST,
        amount: '120.1234567',
        memo: 'skdjfasf',
        memoType: 'MEMO_TEXT',
        msg: 'pay me with lumens',
      },
    },
    {
      name: 'Example 2: payment with a specific asset and callback',
      uri: `web+stellar:pay?destination=${DEST}&amount=120.123&asset_code=USD&asset_issuer=${ISSUER}&memo=hasysda987fs&memo_type=MEMO_TEXT&callback=url%3Ahttps%3A%2F%2FsomeSigningService.com%2Fhasysda987fs%3Fasset%3DUSD`,
      parsed: {
        destination: DEST,
        amount: '120.123',
        assetCode: 'USD',
        assetIssuer: ISSUER,
        memo: 'hasysda987fs',
        memoType: 'MEMO_TEXT',
        callback: 'url:https://someSigningService.com/hasysda987fs?asset=USD',
      },
    },
    {
      name: 'Request Signing example: origin_domain + signature',
      uri: `web+stellar:pay?destination=${DEST}&amount=120.1234567&memo=skdjfasf&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens&origin_domain=someDomain.com&signature=tbsLtlK%2FfouvRWk2UWFP47yHYeI1g1NEC%2FfEQvuXG6V8P%2BbeLxplYbOVtTk1g94Wp97cHZ3pVJy%2FtZNYobl3Cw%3D%3D`,
      parsed: {
        destination: DEST,
        amount: '120.1234567',
        memo: 'skdjfasf',
        memoType: 'MEMO_TEXT',
        msg: 'pay me with lumens',
        originDomain: 'someDomain.com',
        signature:
          'tbsLtlK/fouvRWk2UWFP47yHYeI1g1NEC/fEQvuXG6V8P+beLxplYbOVtTk1g94Wp97cHZ3pVJy/tZNYobl3Cw==',
      },
    },
  ];

  for (const v of SDF_VECTORS) {
    test(`official vector parses and regenerates byte-for-byte — ${v.name}`, () => {
      assert.deepEqual(parsePayUri(v.uri), v.parsed);
      assert.equal(buildPayUri(v.parsed), v.uri);
    });
  }

  test('minimal and optional-field forms', () => {
    assert.deepEqual(parsePayUri(base), { destination: DEST });
    assert.equal(parsePayUri(`${base}&amount=0`).amount, '0');
    assert.equal(parsePayUri('WEB+STELLAR:pay?destination=' + DEST).destination, DEST);
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1));
    const contract = StrKey.encodeContract(Buffer.alloc(32, 2));
    assert.equal(parsePayUri(`web+stellar:pay?destination=${muxed}`).destination, muxed);
    assert.equal(parsePayUri(`web+stellar:pay?destination=${contract}`).destination, contract);
    assert.equal(
      parsePayUri('web+stellar:pay?destination=alice*example.com').destination,
      'alice*example.com',
    );
  });

  test('every memo type: accepted at its boundary, rejected past it', () => {
    const ok = (type, memo) => parsePayUri(`${base}&memo=${enc(memo)}&memo_type=${type}`);
    const bad = (type, memo) =>
      assert.throws(() => ok(type, memo), Sep7Error, `${type} ${memo}`.slice(0, 40));
    assert.equal(ok('MEMO_TEXT', 'a'.repeat(28)).memo.length, 28);
    bad('MEMO_TEXT', 'a'.repeat(29));
    bad('MEMO_TEXT', 'é'.repeat(15)); // 30 bytes, 15 characters
    assert.equal(ok('MEMO_ID', '18446744073709551615').memoType, 'MEMO_ID');
    bad('MEMO_ID', '18446744073709551616');
    bad('MEMO_ID', '-1');
    bad('MEMO_ID', '12abc');
    for (const t of ['MEMO_HASH', 'MEMO_RETURN']) {
      assert.equal(ok(t, B64_32).memo, B64_32);
      bad(t, Buffer.alloc(31).toString('base64'));
      bad(t, 'not base64!');
    }
    assert.throws(() => ok('MEMO_NONE', 'x'), /memo_type must be one of/);
  });

  // [description, uri, expected error fragment]
  const REJECTED = [
    ['empty string', '', /non-empty/],
    ['wrong scheme', `stellar:pay?destination=${DEST}`, /must start with/],
    ['authority slashes', `web+stellar://pay?destination=${DEST}`, /no "\/\/"/],
    ['tx operation', 'web+stellar:tx?xdr=AAAA', /unsupported operation "tx"/],
    ['no query', 'web+stellar:pay', /no query parameters/],
    ['fragment', `${base}#frag`, /fragment/],
    ['missing destination', 'web+stellar:pay?amount=1', /destination is required/],
    ['invalid destination', 'web+stellar:pay?destination=GABC', /not a valid/],
    ['duplicate parameter', `${base}&amount=1&amount=2`, /duplicate parameter "amount"/],
    ['unknown parameter', `${base}&xdr=AAAA`, /unknown parameter "xdr"/],
    ['prototype-key parameter', `${base}&constructor=1`, /unknown parameter/],
    ['empty pair', `${base}&&amount=1`, /malformed query parameter/],
    ['value-less parameter', `${base}&amount`, /malformed query parameter/],
    ['empty value', `${base}&amount=`, /empty value/],
    ['bad percent-encoding', `${base}&msg=%E0%A4%A`, /percent-encoding/],
    ['raw plus is ambiguous', `${base}&msg=a+b`, /unencoded "\+"/],
    ['negative amount', `${base}&amount=-1`, /negative/],
    ['non-numeric amount', `${base}&amount=abc`, /not a valid decimal/],
    ['exponent amount', `${base}&amount=1e7`, /not a valid decimal/],
    ['over-precise amount', `${base}&amount=1.12345678`, /more than 7 decimal/],
    ['asset code without issuer', `${base}&asset_code=USD`, /given together/],
    ['issuer without asset code', `${base}&asset_issuer=${ISSUER}`, /given together/],
    ['13-char asset code', `${base}&asset_code=ABCDEFGHIJKLM&asset_issuer=${ISSUER}`, /1-12/],
    ['bad issuer', `${base}&asset_code=USD&asset_issuer=GABC`, /asset_issuer/],
    ['memo without type', `${base}&memo=hi`, /given together/],
    ['type without memo', `${base}&memo_type=MEMO_TEXT`, /given together/],
    ['non-url callback', `${base}&callback=${enc('other:x')}`, /callback/],
    ['non-http callback', `${base}&callback=${enc('url:ftp://x.example/')}`, /callback/],
    ['over-long msg', `${base}&msg=${'a'.repeat(301)}`, /msg must not exceed 300/],
    ['bad origin_domain', `${base}&origin_domain=not_a_domain`, /origin_domain/],
    ['signature without origin_domain', `${base}&signature=${enc('A'.repeat(88))}`, /requires/],
    ['malformed signature', `${base}&origin_domain=a.example&signature=abc`, /signature must be/],
  ];
  for (const [name, uri, pattern] of REJECTED) {
    test(`rejects: ${name}`, () => {
      assert.throws(
        () => parsePayUri(uri),
        err => err instanceof Sep7Error && pattern.test(err.message),
      );
    });
  }

  test('rejects non-string input and oversized URIs', () => {
    for (const bad of [undefined, null, 42, {}]) assert.throws(() => parsePayUri(bad), Sep7Error);
    assert.throws(() => parsePayUri(`${base}&msg=${'a'.repeat(9000)}`), /exceeds 8192/);
  });

  test('reports every problem at once', () => {
    try {
      parsePayUri(`web+stellar:pay?destination=GABC&amount=-1&bogus=1`);
      assert.fail('expected a throw');
    } catch (err) {
      assert.equal(err.errors.length, 3);
    }
  });

  test('buildPayUri validates with the parser rules and encodes reserved characters', () => {
    assert.throws(() => buildPayUri({ destination: 'GABC' }), Sep7Error);
    assert.throws(() => buildPayUri({ destination: DEST, extra: 1 }), /unknown parameter "extra"/);
    assert.throws(() => buildPayUri({ destination: DEST, amount: 1.5 }), /decimal numeric string/);
    const uri = buildPayUri({ destination: DEST, memo: 'a b&c=d+e', memoType: 'MEMO_TEXT' });
    assert.ok(uri.endsWith('memo=a%20b%26c%3Dd%2Be&memo_type=MEMO_TEXT'));
    assert.equal(parsePayUri(uri).memo, 'a b&c=d+e');
  });

  test('generates a URI from a facilitator payment request (stroops → decimal amount)', () => {
    const uri = payUriFromRequirements(
      { payTo: DEST, amount: '1201234567', network: 'stellar:testnet' },
      { assetCode: 'USD', assetIssuer: ISSUER, memo: '42', memoType: 'MEMO_ID' },
    );
    assert.deepEqual(parsePayUri(uri), {
      destination: DEST,
      amount: '120.1234567',
      assetCode: 'USD',
      assetIssuer: ISSUER,
      memo: '42',
      memoType: 'MEMO_ID',
    });
    assert.equal(
      payUriFromRequirements({ payTo: DEST, amount: '10000000' }).includes('amount=1&'),
      false,
    );
    assert.equal(
      parsePayUri(payUriFromRequirements({ payTo: DEST, amount: '10000000' })).amount,
      '1',
    );
    assert.equal(
      parsePayUri(payUriFromRequirements({ payTo: DEST, amount: 1n })).amount,
      '0.0000001',
    );
    assert.equal(parsePayUri(payUriFromRequirements({ payTo: DEST, amount: '0' })).amount, '0');
    assert.equal(parsePayUri(payUriFromRequirements({ payTo: DEST })).amount, undefined);
  });
});
