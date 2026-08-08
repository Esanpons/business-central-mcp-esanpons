# SaaS handshake spike (F2) — resultados

> Estado: **EJECUTADO y verificado en vivo** (2026-08-08) contra el sandbox `Dev`.
> Captura cruda (secretos redactados): `src/protocol/captures/saas-handshake-2026-08-08.json`.
> Plan: [`2026-08-08-saas-sandbox.md`](2026-08-08-saas-sandbox.md).

## Cómo se ejecutó

`npm run capture:saas` (navegador visible, login + MFA manual). El script engancha el WS del
Web Worker vía CDP (`Target.setAutoAttach` + `Network` por target).

## Resultados (confirmados)

### (a) URL WebSocket — NO es `{baseUrl}/csh`
El servidor asigna un endpoint de **backend regional por pestaña**:
```
wss://msweuweuas4242-7uyvs76.appservices.weu.businesscentral.dynamics.com
     /tenant/msweua3554t30793230/tab/<tabGuid>/csh
     ?ackseqnb=-1&aadTenantId=2c43eb40-...-8a75f7323032&csrftoken=CfDJ8...&traceId=<guid>
```
- host backend != `businesscentral.dynamics.com` (host de app-service regional)
- path `/tenant/{backendTenant}/tab/{tabGuid}/csh`
- query: `ackseqnb=-1`, `aadTenantId=<GUID AAD>`, `csrftoken=CfDJ8...`, `traceId`
- **No derivable de `baseUrl`** → hay que descubrirlo del navegador (lo hace el provider AAD).

### (b) Payload OpenSession
- `applicationId`: **`FIN`** (no NAV) → default de `BC_APPLICATION_ID` en modo AAD.
- `tenantId`: **`msweua3554t30793230`** (el tenant de backend, también en el path de la URL) →
  el provider lo extrae de la URL y lo usa en OpenSession (override sobre `BC_TENANT_ID`).
- `company`: `null` en OpenSession; el servidor abre la default (`CRONUS ES`).
- `features`/`supportedExtensions`: lista moderna; los nuestros (subset) funcionan igual.
- `spaInstanceId`: id corto generado por el cliente (`msk36adr`); el nuestro es propio, sin problema.

### (c) Cookie jar
- Cookies de sesión del WS en el **host de backend**, path `/tenant/.../tab/...`:
  `SessionId`, `.AspNetCore.Cookies`, `.AspNetCore.Antiforgery.47DEQpj8HBQ`, `NAVAllowedAncestor`,
  `ApplicationGatewayAffinity`.
- `csrftoken` del WS = valor de la cookie antiforgery (patrón `CfDJ8...`, misma app ASP.NET).
- Cookies de front-door (`businesscentral.dynamics.com`, path `/{aadTenant}`): `<aad>.auth`,
  `<aad>.Antiforgery.FCE`, `signedOnTenants`, `ASLBSA*`, etc. → se conservan en el jar para la
  inyección del navegador (screenshots/reports), pero NO se mandan al WS.
- **`NAVAllowedAncestor`**: el gateway valida el `Origin` del WS. El upgrade de `ws` sin `Origin`
  ni `User-Agent` de navegador devuelve **HTTP 500**. Solución: mandar
  `Origin: https://businesscentral.dynamics.com` + el `User-Agent` del navegador.

### (d) Flujo OIDC
`GET {baseUrl}` → 302 a `login.microsoftonline.com/{aad}/oauth2/authorize`
(`client_id=996def3d-...`, `redirect_uri=https://businesscentral.dynamics.com/remote-sign-in`,
`response_mode=form_post`, `scope=openid profile`) → login/MFA → `POST /remote-sign-in` →
`GET {baseUrl}?...&runinframe=1` → SPA. Cookies Entra (`ESTSAUTH*`) quedan en
`login.microsoftonline.com`; las de BC en `businesscentral.dynamics.com` + host de backend.

### (e) Deep link SaaS
Path-based; sin `?tenant=`. Los deep links del navegador (screenshots/reports) omiten `tenant=`
en modo AAD.

## Go / No-Go — **GO**

- [x] El frame `OpenSession` y los handlers son los de BC28 → F3 procede sin tocar `protocol/`.
- [x] Ajustado en código: descubrimiento de URL/tenant de backend, `Origin`+`User-Agent` en el WS,
  `applicationId=FIN` por defecto en AAD, cookies de backend para el header del WS.

## Verificación en vivo (`npm run smoke:saas`, 2026-08-08)

Contra `Dev` (CRONUS ES): auth Entra headless (SSO del perfil) → WS al tab de backend →
OpenSession → `openPage 22` (5 clientes reales) → `readRows`/`readField` → `writeField`
`changed=true` + restore. Tell Me devolvió 0 (índice de perfil vacío en sandbox nuevo; no es
un problema de transporte).
