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

/** Value of a `key=value` attribute, keeping every `=` after the first one. */
function attrValue(attr: string): string {
  const eq = attr.indexOf('=');
  return eq < 0 ? '' : attr.slice(eq + 1);
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
    const v = attrValue(ss).toLowerCase();
    sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax';
  }
  // A name/value pair with no '=' (`Set-Cookie: justavalue`) has an EMPTY name and
  // the whole token as its value. `slice(0, -1)` / `slice(0)` would instead have
  // produced a truncated name and the full token as the value, silently corrupting
  // the jar. Likewise attribute values are taken from the FIRST '=' only: a
  // `Path=/tenant/x=y` used to be truncated at the second '='.
  const name = eq < 0 ? '' : nv.slice(0, eq);
  const value = eq < 0 ? nv : nv.slice(eq + 1);
  return {
    name,
    value,
    domain: host,
    path: pathAttr ? (attrValue(pathAttr) || '/') : '/',
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite,
  };
}
