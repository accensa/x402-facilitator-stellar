/**
 * The HTTP surface: /verify, /settle, /supported.
 *
 * @x402/core ships no facilitator router — it gives you x402Facilitator with
 * verify(), settle() and getSupported(), and the transport is yours. This file
 * is that transport and nothing else.
 *
 * Conformance is judged at the wire level: reviewers point stock SDK code at
 * the deliverable rather than read a conformance claim. So the rules here are
 * narrow and deliberate:
 *
 *   - the spec's `payload: {transaction}` shape is accepted verbatim, unwrapped
 *     and un-renamed;
 *   - every rejection carries a non-null reason code, including transport-level
 *     ones, so an agent can branch on a code instead of parsing prose;
 *   - responses are passed through from the scheme untouched.
 *
 * Separated from server.js so the app can be built and exercised in a test
 * without binding a port or holding a real signer. server.js is the process
 * entrypoint and does nothing this file does.
 */
import express from 'express';

/**
 * Builds the Express app.
 *
 * `signers` is deliberately not a parameter: no route reads it. /supported is
 * assembled by the facilitator itself, so the signer addresses reach the wire
 * through getSupported() rather than through here. server.js keeps them only to
 * print the boot banner.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {{verify: Function, settle: Function, getSupported: Function}} facilitator
 * @returns {import('express').Express}
 */
export function createApp(config, facilitator) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  /**
   * Caller authentication.
   *
   * Unset means open. That is the correct default for a free testnet instance —
   * testnet has to be usable without friction — and it is documented rather
   * than silent: the server logs at boot when it is running open.
   */
  function requireApiKey(req, res, next) {
    if (config.apiKeys.length === 0) return next();
    const presented = req.get('authorization')?.replace(/^Bearer /i, '');
    if (!presented || !config.apiKeys.includes(presented)) {
      return res.status(401).json({ error: 'unauthorized', reason: 'invalid_api_key' });
    }
    next();
  }

  /**
   * Both /verify and /settle take {paymentPayload, paymentRequirements}.
   * Returning a non-null reason on a malformed body matters as much as on a
   * failed verification — a null reason anywhere is an acceptance failure.
   */
  function readPaymentBody(req, res) {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({
        isValid: false,
        invalidReason: 'invalid_request',
        invalidMessage: 'body must contain paymentPayload and paymentRequirements',
      });
      return null;
    }
    return { paymentPayload, paymentRequirements };
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  /**
   * GET /supported
   *
   * Must emit the Stellar `extra` block including areFeesSponsored — an explicit
   * acceptance item. getSupported() assembles it from the registered schemes, so
   * it is passed through rather than hand-built.
   */
  app.get('/supported', (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.post('/verify', requireApiKey, async (req, res) => {
    const body = readPaymentBody(req, res);
    if (!body) return;
    try {
      const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      res.json(result);
    } catch (err) {
      // An exception must not become a 500 with an empty body: to a client that
      // is indistinguishable from the service being down, and it carries no
      // reason code. Shape it like a verification failure instead.
      //
      // Note ExactStellarScheme already absorbs its own internal exceptions and
      // returns invalidReason "unexpected_verify_error" rather than throwing, so
      // this path only catches failures above the scheme — an unregistered
      // scheme/network pair, for instance. A distinct code keeps the two
      // distinguishable to a client.
      res.status(200).json({
        isValid: false,
        invalidReason: 'facilitator_error',
        invalidMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/settle', requireApiKey, async (req, res) => {
    const body = readPaymentBody(req, res);
    if (!body) return;
    try {
      const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
      res.json(result);
    } catch (err) {
      // SettleResponse requires `transaction` and `network` even on failure, so
      // a client can attribute the failure without correlating out of band.
      res.status(200).json({
        success: false,
        errorReason: 'facilitator_error',
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
    }
  });

  return app;
}
