// Attributed cookie jar shared between the WebSocket auth path and the
// out-of-band headless browser (screenshots / report downloads). Lives in the
// auth layer so providers can produce it without importing from services/.

export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'None' | 'Lax' | 'Strict';
}

export function parseSetCookie(line: string, host: string): RawCookie {
  const parts = line.split(';').map((s) => s.trim());
  const nv = parts[0] ?? '';
  const attrs = parts.slice(1);
  const eq = nv.indexOf('=');
  const lower = attrs.map((a) => a.toLowerCase());
  const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
  let sameSite: RawCookie['sameSite'] = 'Lax';
  const ss = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
  if (ss) {
    const v = (ss.split('=')[1] ?? '').toLowerCase();
    sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax';
  }
  return {
    name: nv.slice(0, eq),
    value: nv.slice(eq + 1),
    domain: host,
    path: pathAttr ? (pathAttr.split('=')[1] ?? '/') : '/',
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite,
  };
}
