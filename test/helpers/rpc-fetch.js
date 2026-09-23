/**
 * Shared fetch stubs for the rpc-retry and rpc-retry.breaker suites.
 *
 * Both suites exercise `installRpcRetry` (src/rpc-retry.js) by swapping
 * `globalThis.fetch` for a stub rather than touching the network. Keeping the
 * stubs here — instead of copied into each file — means a change in how a
 * transport failure is shaped only has to land once, and the retry semantics
 * are described in exactly one place.
 */

/** Builds an error shaped like the ones undici raises on the transport. */
export function transportError(code, { onCause = false } = {}) {
  const err = new Error(`simulated ${code}`);
  if (onCause) err.cause = { code };
  else err.code = code;
  return err;
}

/**
 * A fetch stub that plays out a scripted sequence of outcomes and counts its
 * calls. An `Error` outcome is thrown; anything else is returned as the
 * Response (an undefined outcome answers with `Response('ok')`).
 */
export function scriptedFetch(...outcomes) {
  const stub = async input => {
    stub.calls++;
    stub.inputs.push(input);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('ok');
  };
  stub.calls = 0;
  stub.inputs = [];
  return stub;
}

/** A fetch stub that fails every call with the given transport code. */
export function failingFetch(code) {
  const stub = async () => {
    stub.calls++;
    throw transportError(code);
  };
  stub.calls = 0;
  return stub;
}
