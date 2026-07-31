import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** Max accepted request body. Prevents an unbounded in-memory buffer from a large/hostile POST. */
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function checkApiToken(req: IncomingMessage, apiToken: string | undefined): boolean {
  if (!apiToken) return true; // No token required
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const expected = `Bearer ${apiToken}`;
  // Constant-time compare so a caller can't recover the token byte-by-byte via
  // response timing. timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
