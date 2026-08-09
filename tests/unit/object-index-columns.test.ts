import { describe, it, expect } from 'vitest';
import { resolveObjectColumns } from '../../src/services/object-index-service.js';

/**
 * T1 — page 9174's columns are LOCALIZED. Hardcoding the English captions made every
 * row unparseable on a Spanish tenant, and the empty result then overwrote a good
 * 14k-object index (live incident, SaaS, 2026-08-09). These are the exact key sets
 * observed on the wire.
 */
describe('resolveObjectColumns', () => {
  it('resolves the English columns (Docker/devel1)', () => {
    const cols = resolveObjectColumns(['Object Type', 'Object ID', 'Object Name', 'Object Caption', 'App Name']);
    expect(cols).toEqual({
      id: 'Object ID',
      type: 'Object Type',
      name: 'Object Name',
      caption: 'Object Caption',
      app: 'App Name',
    });
  });

  it('resolves the Spanish columns (SaaS CRONUS ES — the keys that broke the refresh)', () => {
    const cols = resolveObjectColumns([
      'Tipo objeto', 'Por', 'Id. objeto', 'Nombre objeto', 'Título objeto', 'Subtipo de objeto', 'Nombre de aplicación',
    ]);
    expect(cols).toEqual({
      id: 'Id. objeto',
      type: 'Tipo objeto',
      name: 'Nombre objeto',
      caption: 'Título objeto',
      app: 'Nombre de aplicación',
    });
  });

  it('resolves Catalan columns', () => {
    const cols = resolveObjectColumns(['Tipus objecte', 'Id. objecte', 'Nom objecte', 'Títol objecte', "Nom de l'aplicació"]);
    expect(cols?.id).toBe('Id. objecte');
    expect(cols?.type).toBe('Tipus objecte');
    expect(cols?.name).toBe('Nom objecte');
    expect(cols?.caption).toBe('Títol objecte');
  });

  it('never picks "Subtipo de objeto" as the type column', () => {
    const cols = resolveObjectColumns(['Subtipo de objeto', 'Tipo objeto', 'Id. objeto', 'Nombre objeto']);
    expect(cols?.type).toBe('Tipo objeto');
  });

  it('never picks the application name as the object name', () => {
    const cols = resolveObjectColumns(['Nombre de aplicación', 'Id. objeto', 'Tipo objeto', 'Nombre objeto']);
    expect(cols?.name).toBe('Nombre objeto');
    expect(cols?.app).toBe('Nombre de aplicación');
  });

  it('returns null when the mandatory columns are absent, so the caller can fail loudly', () => {
    expect(resolveObjectColumns(['Something', 'Else'])).toBeNull();
    // id + name but no type -> still unusable
    expect(resolveObjectColumns(['Id. objeto', 'Nombre objeto'])).toBeNull();
  });

  it('tolerates an environment that omits caption/app', () => {
    const cols = resolveObjectColumns(['Object ID', 'Object Type', 'Object Name']);
    expect(cols).toEqual({ id: 'Object ID', type: 'Object Type', name: 'Object Name' });
  });
});
