/**
 * Audit logging for sensitive operations (issue #109).
 *
 * An audit trail is a different artifact from diagnostic logging: it is a
 * record of who did what, retained and reviewed as such. It is deliberately
 * NOT a second logging framework — it is a thin, structured writer whose
 * records are distinguishable from diagnostics by the "channel": "audit"
 * marker on every line, so they can be shipped, filtered and retained
 * independently of application logs (#7 covers the diagnostic side).
 *
 * WHAT IS AUDITED is enumerated in docs/AUDIT.md with reasons. The rule of
 * thumb: record events that move or risk money, change public state, or
 * concern authentication — not reads.
 *
 * SANITISATION. Records carry identity (req.keyId, never the key material),
 * action, outcome, and just enough context to reconstruct the event (a
 * transaction hash). Full request payloads are never passed here, and as
 * defence in depth the writer redacts anything whose field name looks secret-
 * shaped before it leaves the process.
 */

import fs from 'node:fs';

/** Field names that must never appear in an audit line, however they arrive. */
const SECRET_SHAPED =
  /secret|signature|token|password|authorization|payload|paymentrequirements|paymentpayload|xdr/i;

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_SHAPED.test(k) ? '[redacted]' : v;
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {Function} [options.write] - sinks the encoded line; injectable so
 *   tests can capture records instead of writing to the process streams
 * @param {string} [options.file] - AUDIT_LOG_FILE: append records to a file as
 *   well as stdout, which gives an operator a separable retention surface
 *   without shipping infrastructure this spike does not have
 * @param {(message: string) => void} [options.onError] - receives the one
 *   warning emitted if the file sink fails, so a test can capture it
 */
export function createAuditLogger({
  write,
  file,
  onError = message => console.error(message),
} = {}) {
  let stream;
  if (file) {
    stream = fs.createWriteStream(file, { flags: 'a' });
    // POSTURE: an unusable AUDIT_LOG_FILE is reported once and the stdout
    // channel keeps working. The file sink is an extra retention surface, so
    // it must never be able to take settlement serving down through the
    // process-level uncaught-exception handler (src/server.js).
    stream.on('error', err => {
      if (!stream) return;
      stream = null;
      onError(
        `[Audit] cannot write AUDIT_LOG_FILE (${err.message}); audit records continue on stdout only`,
      );
    });
  }

  function emit(line) {
    if (write) {
      write(line);
      return;
    }
    process.stdout.write(`${line}\n`);
    // Diagnostic logs go to stdout via console.log too; that is fine — the
    // channel marker, not the fd, is what separates audit from diagnostics,
    // and AUDIT_LOG_FILE exists for operators who want physical separation.
    if (stream) stream.write(`${line}\n`);
  }

  /**
   * Records one auditable event.
   *
   * @param {string} event - e.g. 'settlement', 'auth_failure'
   * @param {object} fields - timestamp and channel are added here; pass only
   *   fields you would be comfortable showing the caller being recorded
   */
  function audit(event, fields = {}) {
    emit(
      JSON.stringify({
        ts: new Date().toISOString(),
        channel: 'audit',
        event,
        ...redact(fields),
      }),
    );
  }

  /**
   * Flushes and closes the file sink. Awaiting this in shutdown() is what
   * guarantees a record written immediately before a graceful stop reaches
   * the file rather than sitting in the stream's buffer.
   *
   * @returns {Promise<void>}
   */
  audit.close = function close() {
    const open = stream;
    stream = null;
    if (!open) return Promise.resolve();
    return new Promise(resolve => open.end(resolve));
  };

  return audit;
}
