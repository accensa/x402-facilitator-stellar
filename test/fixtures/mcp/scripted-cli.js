#!/usr/bin/env node

/**
 * A scripted MCP stdio peer for the client tests (#386).
 *
 * The real `src/mcp/cli.js` is exercised end-to-end elsewhere in
 * test/mcp.test.js, but the failure modes this fixture covers — a tool that
 * answers with a JSON-RPC error, a peer that prints non-JSON noise on stdout,
 * one that replies in fragments, one that never replies, and one that dies with
 * a request in flight — cannot be produced on demand by the real CLI without
 * stubbing the x402 SDK or waiting on the network.
 *
 * `FAKE_MCP_MODE` selects the behaviour; the default is a well-behaved echo
 * peer, so a test can opt into a failure instead of inheriting one.
 *
 * Modes:
 *   echo (default)  answer every request with the echoed tool name
 *   tool-error      answer with a JSON-RPC error carrying code and data
 *   garbage         print a non-JSON line, then a valid response
 *   split           write one valid response in single-byte fragments
 *   silent          accept the request and never answer it
 *   exit            log to stderr and exit(3) on the first request
 */

// `node --test` collects every JavaScript file under test/, this fixture
// included, and would run it as a test file. With no peer on the other end of
// stdin it would sit there forever and hang the entire suite — which is what
// broke CI (#470). NODE_TEST_CONTEXT is set by the runner in a file it
// collected, but stripped from the peers this fixture is actually spawned as
// (see createMcpClient), so it identifies exactly the case that must bail out.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

let buffer = '';
const MODE = process.env.FAKE_MCP_MODE || 'echo';

function respond(msg) {
  const result = { content: [{ type: 'text', text: `echo:${msg.params?.name}` }], isError: false };
  const payload = `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`;

  if (MODE === 'split') {
    // One byte per turn of the event loop: every chunk boundary lands inside
    // the response, which is what the framer has to survive.
    let i = 0;
    const writeOne = () => {
      if (i >= payload.length) return;
      process.stdout.write(payload[i]);
      i += 1;
      process.nextTick(writeOne);
    };
    writeOne();
    return;
  }

  if (MODE === 'garbage') process.stdout.write('this line is not json\n');
  process.stdout.write(payload);
}

function handle(msg) {
  if (MODE === 'silent') return;

  if (MODE === 'exit') {
    process.stderr.write('scripted peer exiting mid-request\n');
    process.exit(3);
  }

  if (MODE === 'tool-error') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'scripted tool failure', data: { hint: 'retry later' } },
      })}\n`,
    );
    return;
  }

  respond(msg);
}

process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
