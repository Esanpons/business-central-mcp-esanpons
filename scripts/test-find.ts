// Find-only test against the existing cached index (no BC session needed).
import { ObjectIndexService } from '../src/services/object-index-service.js';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const svc = new ObjectIndexService(null as never, './.state', 'devel1', 'default', log as never);

for (const q of ['Customer List', 'customer', 'sales order', 'item']) {
  const r = svc.find(q, { type: 'Page', limit: 4 });
  console.log(`\nPAGE "${q}" -> ${r.count}`);
  for (const o of r.results) console.log(`  ${o.type} ${o.id}  ${o.name}  | ${o.caption}`);
}
console.log('\nany type "ledger entry":');
for (const o of svc.find('ledger entry', { limit: 6 }).results) console.log(`  ${o.type} ${o.id}  ${o.name}`);
