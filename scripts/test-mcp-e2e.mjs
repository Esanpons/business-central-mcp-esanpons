// End-to-end MCP test: spawn the built stdio server and exercise the new tools
// (bc_health, bc_screenshot, bc_build_manual) over JSON-RPC, as Claude would.
// Run: node scripts/test-mcp-e2e.mjs
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

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}
const textOf = (r) => (r.result?.content || []).find((c) => c.type === 'text')?.text;

await rpc('initialize', {});

const list = await rpc('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
console.log(`tools (${names.length}):`, names.join(', '));
for (const t of ['bc_health', 'bc_screenshot', 'bc_build_manual']) {
  console.log(`  ${t} registered:`, names.includes(t));
}

// bc_health (no session needed)
const health = await rpc('tools/call', { name: 'bc_health', arguments: {} });
console.log('\n[bc_health]\n', textOf(health));

// bc_screenshot with numbered badges + crop
const shot = await rpc('tools/call', {
  name: 'bc_screenshot',
  arguments: { pageId: 22, highlight: ['No.', 'Name'], crop: ['No.', 'Name'], out: 'e2e-badges.png', inline: false },
});
console.log('\n[bc_screenshot]\n', textOf(shot));

// bc_build_manual (1 step, md only for speed)
const manual = await rpc('tools/call', {
  name: 'bc_build_manual',
  arguments: {
    title: 'E2E smoke manual', name: 'e2e-smoke',
    steps: [{ heading: 'Customer list', body: 'The customer list.', screenshot: { pageId: 22 } }],
    formats: ['md', 'pdf', 'docx'],
  },
});
console.log('\n[bc_build_manual]\n', textOf(manual));

srv.kill();
process.exit(0);
