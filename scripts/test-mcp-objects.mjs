// MCP e2e for the object-index tools. Run: node scripts/test-mcp-objects.mjs
import { spawn } from 'node:child_process';
const srv = spawn('node', ['dist/stdio-server.js'], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const textOf = (r) => (r.result?.content || []).find((c) => c.type === 'text')?.text;

await rpc('initialize', {});
const list = await rpc('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
console.log(`tools (${names.length}). new:`, ['bc_find_object', 'bc_refresh_objects'].map((n) => `${n}=${names.includes(n)}`).join(', '));

const find = await rpc('tools/call', { name: 'bc_find_object', arguments: { query: 'Customer List', type: 'Page' } });
console.log('\n[bc_find_object "Customer List" type=Page]\n', textOf(find));

srv.kill(); process.exit(0);
