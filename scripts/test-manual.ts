// Functional test of the ManualService against live BC (md + printable A4 html).
// Run: tsx scripts/test-manual.ts   -- for a BC-free layout check use scripts/verify-manual-html.ts
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';
import { ManualService } from '../src/services/manual-service.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const ss = new ScreenshotService(config.bc, config.screenshotDir, () => 'CRONUS_01', logger);
const ms = new ManualService(ss, config.manualDir, logger);

const r = await ms.build({
  title: 'Com crear un client',
  intro: "Aquesta guia mostra com obrir la llista de clients i emplenar els camps clau d'una fitxa.",
  name: 'crear-client',
  steps: [
    { heading: 'Obre la llista de clients', body: 'Cerca "Customers" i obre la llista.', screenshot: { pageId: 22 } },
    {
      heading: 'Emplena els camps clau',
      body: 'Indica el Nom i el Límit de crèdit del client.',
      screenshot: { pageId: 21, bookmark: '1B_EgAAAAJ7CDAAMQAxADIAMQAyADEAMg', company: 'CRONUS_01', highlight: ['Name', 'Credit Limit (LCY)'] },
    },
  ],
  formats: ['md', 'html'],
});
console.log(JSON.stringify(r, null, 2));
