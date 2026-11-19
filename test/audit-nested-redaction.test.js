/**
 * Nested redaction in the audit writer (#760).
 *
 * The writer's SECRET_SHAPED key filter used to run on the top-level fields
 * object only: a secret-shaped key inside a nested object (details.clientSecret,
 * context.paymentPayload.xdr) reached the audit line as plaintext. These tests
 * drive the public audit() surface (createAuditLogger) and assert deep,
 * non-mutating redaction.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditLogger } from '../src/audit.js';

/** Captures the JSON audit lines written by one logger. */
function captureAudit() {
  const lines = [];
  const audit = createAuditLogger({ write: line => lines.push(line) });
  return {
    audit,
    records: () => lines.map(line => JSON.parse(line)),
  };
}

describe('nested redaction (#760)', () => {
  test('secret-shaped keys are redacted at depth 2 through the audit line', () => {
    const { audit, records } = captureAudit();
    audit('test', {
      actor: 'ADMIN',
      details: {
        clientSecret: 'nested-secret',
        note: 'visible',
      },
    });
    const [record] = records();
    assert.equal(record.actor, 'ADMIN');
    assert.equal(record.details.clientSecret, '[redacted]');
    assert.equal(record.details.note, 'visible');
  });

  test('deep nesting is redacted at every level', () => {
    const { audit, records } = captureAudit();
    audit('test', {
      details: {
        level1: {
          level2: {
            level3: {
              api_token: 'deep-secret',
              ok: true,
            },
            clientSecret: 'shallow-secret',
          },
        },
      },
    });
    const [record] = records();
    const l3 = record.details.level1.level2.level3;
    assert.equal(l3.api_token, '[redacted]');
    assert.equal(l3.ok, true);
    assert.equal(record.details.level1.level2.clientSecret, '[redacted]');
  });

  test('authorization, xdr and payment payload secrets are redacted wherever they sit', () => {
    const { audit, records } = captureAudit();
    audit('test', {
      authorization: 'Bearer abc.def.ghi',
      context: {
        paymentPayload: { xdr: 'AAAA-CCCLIENT...' },
        details: { xdr: 'BBBB-RAW-XDR' },
      },
      meta: { note: 'visible', signature: 'SIG-shh' },
    });
    const [record] = records();
    assert.equal(record.authorization, '[redacted]');
    // The paymentPayload key itself is secret-shaped: the whole value goes.
    assert.equal(record.context.paymentPayload, '[redacted]');
    // A leaf xdr under a non-matching parent is redacted too.
    assert.equal(record.context.details.xdr, '[redacted]');
    assert.equal(record.meta.note, 'visible');
    assert.equal(record.meta.signature, '[redacted]');
  });

  test('secret-shaped keys inside arrays are redacted, siblings preserved', () => {
    const { audit, records } = captureAudit();
    audit('test', {
      actor: 'ADMIN',
      batch: [{ authorization: 'Bearer abc', note: 'ok' }, { xdr: 'AAAA...', count: 7 }, 'plain'],
    });
    const [record] = records();
    assert.equal(record.actor, 'ADMIN');
    assert.equal(record.batch[0].authorization, '[redacted]');
    assert.equal(record.batch[0].note, 'ok');
    assert.equal(record.batch[1].xdr, '[redacted]');
    assert.equal(record.batch[1].count, 7);
    assert.equal(record.batch[2], 'plain');
  });

  test('top-level non-secret fields are unchanged', () => {
    const { audit, records } = captureAudit();
    audit('settlement', {
      actor: 'ADMIN',
      outcome: 'settled',
      transaction: 'abc123',
      network: 'stellar:testnet',
    });
    const [record] = records();
    assert.equal(record.event, 'settlement');
    assert.equal(record.actor, 'ADMIN');
    assert.equal(record.outcome, 'settled');
    assert.equal(record.transaction, 'abc123');
    assert.equal(record.network, 'stellar:testnet');
  });

  test('redaction does not mutate the caller object', () => {
    const { audit } = captureAudit();
    const details = { clientSecret: 's3cret', note: 'visible' };
    audit('test', { actor: 'ADMIN', details });
    assert.equal(details.clientSecret, 's3cret', 'input object must not be redacted in place');
    assert.equal(details.note, 'visible');
  });

  test('a cycle in the input is written as [circular], not a throw', () => {
    const { audit, records } = captureAudit();
    const fields = { actor: 'ADMIN' };
    fields.self = fields;
    assert.doesNotThrow(() => audit('test', fields));
    const [record] = records();
    assert.equal(record.actor, 'ADMIN');
    assert.equal(record.self, '[circular]');
  });

  test('a __proto__ key cannot pollute Object.prototype', () => {
    const { audit, records } = captureAudit();
    const fields = JSON.parse('{"actor":"ADMIN","__proto__":{"polluted":"yes"}}');
    assert.doesNotThrow(() => audit('test', fields));
    const [record] = records();
    assert.equal({}.polluted, undefined, 'Object.prototype must not gain a key');
    assert.equal(Object.getPrototypeOf(record), Object.prototype);
    assert.ok(Object.hasOwn(record, '__proto__'), 'the key is kept as an own property');
  });

  test('null and primitive leaf values pass through unchanged', () => {
    const { audit, records } = captureAudit();
    audit('test', {
      actor: 'ADMIN',
      count: 42,
      flag: true,
      empty: null,
      nested: { amount: 1234.5 },
    });
    const [record] = records();
    assert.equal(record.count, 42);
    assert.equal(record.flag, true);
    assert.equal(record.empty, null);
    assert.equal(record.nested.amount, 1234.5);
  });
});
