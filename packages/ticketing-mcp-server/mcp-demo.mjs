/**
 * mcp-demo.mjs — minimal MCP stdio test-client
 *
 * 1. Clears any cached tokens so we always go through the OAuth flow.
 * 2. Spawns the ticketing MCP server.
 * 3. Sends: initialize → search_events → create_order → complete_payment
 * 4. The server triggers OAuth on the first tool call; it prints the URL to
 *    stderr.  We echo that URL to OUR stderr so the parent (Claude Code) can
 *    see it and navigate the browser to it.
 * 5. Once the OAuth callback is received by the server, the tool call
 *    completes and the result comes back on stdout as a JSON-RPC response.
 */

import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = join(homedir(), '.config', 'ticketing-mcp', 'tokens.json');
if (existsSync(TOKEN_FILE)) {
  unlinkSync(TOKEN_FILE);
  console.error('[demo] cleared cached tokens — fresh OAuth flow');
}

const __dir = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dir, 'dist', 'index.js');

const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, TICKETING_API_URL: 'http://localhost:8000' },
  stdio: ['pipe', 'pipe', 'inherit'], // stderr goes straight to our terminal
});

// ---------- JSON-RPC helpers ----------
let msgId = 1;
function send(obj) {
  const raw = JSON.stringify(obj);
  server.stdin.write(raw + '\n');
}

function rpc(method, params = {}) {
  const id = msgId++;
  send({ jsonrpc: '2.0', id, method, params });
  return id;
}

// ---------- Read newline-delimited JSON from server stdout ----------
let buf = '';
const pending = new Map(); // id → { resolve, reject }

server.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = rpc(method, params);
    pending.set(id, { resolve, reject });
  });
}

// ---------- Main flow ----------
async function main() {
  // 1. Initialize
  console.error('[demo] → initialize');
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-demo', version: '0.0.1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  console.error('[demo] ✓ initialized');

  // 2. search_events — triggers OAuth flow on first tool call
  console.error('[demo] → search_events (will trigger OAuth login…)');
  const eventsResult = await call('tools/call', {
    name: 'search_events',
    arguments: {},
  });
  console.error('[demo] ✓ search_events completed');
  console.log('\n=== SEARCH EVENTS RESULT ===');
  console.log(JSON.stringify(eventsResult, null, 2));

  // Parse the first ticket from the result text
  let ticketId, price;
  try {
    const text = eventsResult.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    const first = parsed.tickets?.[0] ?? parsed[0];
    ticketId = first?.id ?? first?.ticketId;
    price = first?.price;
  } catch {
    console.error('[demo] Could not parse ticket from result — check raw output above');
  }

  if (!ticketId) {
    console.error('[demo] No tickets found — aborting.');
    server.kill();
    return;
  }

  console.error(`[demo] → create_order ticketId=${ticketId} price=${price}`);

  // 3. create_order
  const orderResult = await call('tools/call', {
    name: 'create_order',
    arguments: { ticketId, quantity: 1 },
  });
  console.log('\n=== CREATE ORDER RESULT ===');
  console.log(JSON.stringify(orderResult, null, 2));

  let orderId;
  try {
    const text = orderResult.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    orderId = parsed.order?.id ?? parsed.id ?? parsed.orderId;
  } catch { /* handled below */ }

  if (!orderId) {
    console.error('[demo] No orderId returned — aborting.');
    server.kill();
    return;
  }

  console.error(`[demo] → pay_for_order orderId=${orderId}`);

  // 4. pay_for_order (mock mode: any token string accepted)
  const paymentResult = await call('tools/call', {
    name: 'pay_for_order',
    arguments: { orderId, paymentToken: 'pm_mock_success' },
  });
  console.log('\n=== COMPLETE PAYMENT RESULT ===');
  console.log(JSON.stringify(paymentResult, null, 2));

  console.error('[demo] ✓ All done!');
  server.kill();
}

main().catch((err) => {
  console.error('[demo] ERROR:', err.message);
  server.kill();
  process.exit(1);
});
