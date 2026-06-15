// End-to-end MCP test: spawn the built stdio server and call bc_screenshot
// over JSON-RPC, exactly as Claude would. Run: node scripts/test-mcp-e2e.mjs
import { spawn } from 'node:child_process';

const srv = spawn('node', ['dist/stdio-server.js'], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(id, method, params) {
  return new Promise((res) => {
    pending.set(id, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const init = await rpc(1, 'initialize', {});
console.log('initialize:', init.result?.serverInfo);

const list = await rpc(2, 'tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
console.log('bc_screenshot registered:', names.includes('bc_screenshot'), `(${names.length} tools total)`);

const call = await rpc(3, 'tools/call', {
  name: 'bc_screenshot',
  arguments: { pageId: 21, bookmark: '1B_EgAAAAJ7CDAAMQAxADIAMQAyADEAMg', company: 'CRONUS_01', highlight: 'Credit Limit (LCY)', out: 'mcp-e2e.png', inline: true },
});
const content = call.result?.content || [];
console.log('isError:', !!call.result?.isError);
console.log('content blocks:', content.map((c) => c.type));
const text = content.find((c) => c.type === 'text');
const image = content.find((c) => c.type === 'image');
if (text) console.log('text payload:', text.text);
if (image) console.log('image block: mimeType =', image.mimeType, ', base64 length =', image.data?.length);

srv.kill();
process.exit(0);
