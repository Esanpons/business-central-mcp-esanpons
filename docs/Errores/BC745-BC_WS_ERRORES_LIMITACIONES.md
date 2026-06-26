# Incidencias y limitaciones encontradas con `bc-ws`

Fecha: 2026-06-26  
Tarea: BC745  
Entorno: `https://devel1/BC`, tenant `default`, empresa principal usada `CRONUS_04`  
Objetivo funcional: reproducir en entorno actual el bug de tres direcciones en el report `50002` / página `Sales Quote`.

## Contexto de la reproducción BC745

Se necesita reproducir el error **en el entorno actual**, no usando solo las imágenes adjuntas de Jira.

Caso preparado en el entorno actual:

- Empresa: `CRONUS_04`.
- Oferta: `2000052`.
- Página: `Sales Quote` (`pageId = 41`).
- Bookmark usado: `1F_JAAAAACLAAAAAAJ7BzIAMAAwADAAMAA1ADI`.
- Estado actual del documento tras preparar la prueba: `Released`.
- Versión publicada actualmente para reproducir el ANTES: **versión temporal con bug** de `GlobalBaseJBC`.
- Condición funcional buscada:
  - `Ship-to = Default (Sell-to Address)` → envío igual al cliente.
  - `Bill-to = Custom Address` → facturación distinta.
  - `Bill-to Address = BC745 BILL-TO ADDRESS`.
  - Si el report imprime tres bloques de dirección, reproduce el bug.

## Regla de documentación para futuros fallbacks

Cada vez que `bc-ws` no permita completar una operación y haya que pasar a Playwright, se debe documentar aquí:

1. herramienta `bc-ws` usada;
2. parámetros relevantes;
3. error devuelto;
4. por qué bloquea el flujo;
5. qué se hizo en Playwright;
6. ejemplo mínimo para reproducirlo.

---

## 1. `bc_execute_action`: no se puede invocar por el esquema actual cuando solo quieres pasar `action`

### Qué quería hacer

Ejecutar acciones de la página desde `bc-ws`, por ejemplo:

- `Editar`
- `Re&open`
- `Re&lease`
- `&Print...`

### Ejemplo de llamada intentada

La intención real era enviar solo `action`, como indica la documentación del tool:

```json
{
  "pageContextId": "session:page:41:41cc56ae",
  "action": "Re&lease",
  "quiet": true
}
```

Pero el schema publicado por la herramienta marca también `cue` como requerido. Para intentar satisfacer el schema se probó con un placeholder:

```json
{
  "pageContextId": "session:page:41:41cc56ae",
  "action": "Re&lease",
  "cue": ".",
  "section": "",
  "rowIndex": 0,
  "bookmark": "",
  "quiet": true
}
```

### Error recibido

```text
Input validation error:
[
  {
    "code": "custom",
    "path": [],
    "message": "Provide exactly one of: action, cue"
  }
]
```

### Problema

Hay una contradicción práctica entre:

- la documentación del tool, que dice que se debe usar **exactamente uno** entre `action` y `cue`;
- el schema visible en Kilo, donde `action` y `cue` aparecen como campos requeridos/no opcionales.

Resultado: no pude invocar acciones normales solo con `action` desde `bc-ws`.

### Impacto en BC745

Bloqueó estas acciones necesarias:

- reabrir la oferta;
- liberar la oferta;
- lanzar Print/Send > Print.

### Fallback usado

Se usó Playwright para pulsar acciones visibles en el cliente web:

```js
const frame = page.frameLocator('iframe');
await frame.locator('[role="menuitem"],button')
  .evaluateAll(els => {
    const matches = els.filter(e =>
      !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) &&
      ((e.getAttribute('aria-label') || e.textContent || '').trim() === 'Release')
    );
    const el = matches[matches.length - 1];
    if (el) el.click();
  });
```

### Caso mínimo para reproducir

1. Abrir una `Sales Quote` con `bc_open_page`.
2. Intentar ejecutar una acción de cabecera con `bc_execute_action` pasando solo `action`.
3. Si Kilo fuerza el schema actual, no deja omitir `cue`.
4. Si se informa `cue` como placeholder, el validador interno rechaza porque hay `action` + `cue`.

---

## 2. `bc_download_report`: timeout con report `50002` / Sales Quote

### Qué quería hacer

Descargar directamente el PDF del report `50002` para capturar el ANTES real del bug.

### Llamada intentada

```json
{
  "reportId": 50002,
  "company": "CRONUS_04",
  "out": "D:\\Proyectos\\0_JBC\\_PORTABILITAT_Business Central\\_Business Central\\_Workspace\\.screenshots\\BC745\\antes_real_bug.pdf",
  "timeoutMs": 120000
}
```

También se probó antes en `CRONUS_01`.

### Error recibido

```text
MCP error -32001: Request timed out
```

### Problema

El report `50002` no es un report simple sin contexto. Al ejecutarse necesita request page/contexto/filtro de documento. `bc_download_report` intenta descargar el output en navegador out-of-band, pero no permitió parametrizar de forma estable el documento concreto `Sales Quote 2000052` ni completar la request page.

### Impacto en BC745

No pude obtener el PDF directamente con `bc-ws`, que era la evidencia visual clave del ANTES/DESPUÉS.

### Fallback usado

Se pasó a Playwright para abrir la oferta real en el cliente web y usar el menú `Print/Send > Print...`.

### Caso mínimo para reproducir

1. Tener una oferta real en `CRONUS_04`.
2. Ejecutar:

```json
{
  "reportId": 50002,
  "company": "CRONUS_04",
  "timeoutMs": 120000
}
```

3. Resultado esperado actual: timeout o request page sin descarga usable.
4. Resultado deseable: permitir indicar filtros/request page o usar el contexto de una página abierta/documento actual.

---

## 3. `bc_run_report`: abre request page, pero no permite filtrar fácilmente el documento actual

### Qué quería hacer

Usar `bc_run_report` como alternativa a `bc_download_report`, para ver si se podía ejecutar el report desde request page.

### Llamada usada

```json
{
  "reportId": 50002
}
```

### Resultado recibido

La llamada devuelve `success: true` y una request page `formId = E9`, con campos como:

- `Impresora`
- `Diseño de informe`
- `Languaje Code`
- límites de filas/documentos

Pero no apareció un filtro claro editable sobre `Sales Header` / `No.` para restringir al documento `2000052`.

### Problema

El tool expone la request page, pero para este report no resultó suficiente para reproducir el flujo del botón `Print/Send` de la oferta actual.

### Impacto en BC745

No sirvió para generar el PDF del documento real que hay que comparar antes/después.

### Fallback usado

Playwright, porque el cliente web sí conserva el contexto visual de la oferta abierta y permite usar el menú estándar.

### Caso mínimo para reproducir

1. Abrir una oferta concreta con `bc_open_page`.
2. Ejecutar `bc_run_report` para `50002`.
3. Comprobar si hay forma de indicar `Document Type = Quote` + `No. = 2000052`.
4. Si no aparece, no se puede generar la evidencia exacta desde `bc-ws`.

---

## 4. `bc_screenshot`: cuidado con rutas relativas bajo `.screenshots`

### Qué quería hacer

Guardar capturas bajo `.screenshots/BC745/`.

### Llamada problemática

```json
{
  "pageId": 41,
  "bookmark": "1F_JAAAAACLAAAAAAJ7BzIAMAAwADAAMAA1ADI",
  "company": "CRONUS_01",
  "out": ".screenshots\\BC745\\antes_01_condicion_direcciones_oferta.png",
  "inline": false
}
```

### Resultado observado

El fichero se guardó en una ruta inesperada:

```text
...\\_Workspace\\screenshots\\.screenshots\\BC745\\antes_01_condicion_direcciones_oferta.png
```

### Problema

Cuando `out` es relativo, la herramienta lo resuelve bajo `BC_SCREENSHOT_DIR`. Si el path relativo ya contiene `.screenshots`, queda duplicado o desplazado bajo `screenshots/.screenshots`.

### Impacto

Puede dejar evidencias fuera de la carpeta esperada.

### Recomendación

Usar siempre ruta absoluta cuando se quiera controlar exactamente el destino:

```json
{
  "out": "D:\\Proyectos\\0_JBC\\_PORTABILITAT_Business Central\\_Business Central\\_Workspace\\.screenshots\\BC745\\despues_01.png"
}
```

---

## 5. `bc_screenshot`: bookmark de una empresa usado en otra empresa genera diálogo de registro no encontrado

### Qué ocurrió

Se usó el bookmark de la oferta `2000052`, que pertenece a `CRONUS_04`, intentando capturar en `CRONUS_01`.

### Resultado visual

La captura mostró diálogo:

```text
No se encuentra el registro solicitado.
```

### Interpretación

Esto no parece un bug de `bc-ws`, sino una limitación/casuística importante: los bookmarks son dependientes de empresa/datos. Hay que fijar siempre la misma empresa con la que se obtuvo el bookmark.

### Recomendación

Documentar en el uso de `bc_screenshot` que `bookmark + company` deben pertenecer al mismo contexto.

---

## 6. `bc_write_data`: `success: true` no significa necesariamente que el valor haya quedado guardado

### Qué ocurrió

Al intentar escribir campos no editables de Bill-to, el resultado devolvió `success: true`, pero también:

```json
{
  "changed": false,
  "reason": "not editable"
}
```

Ejemplo:

```json
{
  "fieldName": "Address",
  "success": true,
  "requested": "BC745 BILL-TO ADDRESS",
  "changed": false,
  "reason": "not editable",
  "newValue": "13-1"
}
```

### Problema

Para automatización puede inducir a error si solo se revisa `success` o `allSucceeded` superficialmente.

### Recomendación

En cualquier flujo de prueba automatizado, validar siempre `changed` y `newValue`, no solo `success`.

---

## 7. Por qué se tuvo que usar Playwright en BC745

Se pasó a Playwright por tres motivos acumulados:

1. `bc_execute_action` no permitió ejecutar acciones de página por la contradicción `action`/`cue`.
2. `bc_download_report` no descargó el report `50002` por timeout/request page.
3. `bc_run_report` abrió request page pero no dejó filtrar de forma clara el documento concreto.

Playwright permitió:

- iniciar sesión en el cliente web;
- abrir la oferta `2000052`;
- reabrir la oferta;
- cambiar `Bill-to` a `Custom Address`;
- corregir errores de validación visuales;
- liberar la oferta;
- dejar el documento listo para imprimir con la versión buggy publicada.

---

## 8. `bc-ws`: `SESSION_LOST` tras publicar una extensión se recupera reintentando

### Qué ocurrió

Después de reaplicar el fix AL y publicar `GlobalBaseJBC`, Business Central cerró las páginas abiertas con el mensaje estándar:

```text
Un administrador ha cambiado una o más extensiones de la aplicación, por lo que se tuvo que cerrar la página en la que estaba trabajando.
```

En Playwright se pudo aceptar el diálogo. Inicialmente `bc-ws` quedó desconectado, pero al reintentar una operación el propio MCP recreó la sesión correctamente.

### Llamada que falló

```json
{
  "pageId": 9300,
  "sections": ["header"],
  "columns": ["No.", "Sell-to Customer Name", "Status"],
  "range": { "offset": 0, "limit": 100 }
}
```

### Error recibido

```text
Error [SESSION_LOST]: The Business Central session was lost. It reconnects automatically; re-open any pages you had open and retry.
```

`bc_health` devolvió:

```json
{
  "status": "disconnected",
  "session": {
    "alive": false,
    "company": "CRONUS_04",
    "openForms": 5,
    "modalDepth": 1
  },
  "metrics": {
    "lastError": "InvalidSessionException"
  }
}
```

### Comportamiento observado

Primera llamada tras publicar:

```text
Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.
```

Después de esa llamada, `bc_health` devolvió:

```json
{
  "status": "connected",
  "session": {
    "alive": true,
    "company": "CRONUS_04",
    "openForms": 1,
    "modalDepth": 0
  }
}
```

Después se pudo reabrir `Sales Quotes` con `bc_open_page` correctamente.

### Problema real

El cierre de páginas por publicación de extensión es normal en BC. La recuperación de `bc-ws` funciona, pero requiere **reintentar la operación** después del primer `SESSION_LOST`. Los `pageContextId` anteriores quedan inválidos y hay que reabrir las páginas.

### Impacto en BC745

Después de publicar el fix, se pudo recuperar la sesión y reabrir la lista con `bc-ws`. Lo que siguió bloqueando la verificación fue el problema independiente de `bc_execute_action` con `action`/`cue` al intentar lanzar `&Print...`.

### Caso mínimo para reproducir

1. Abrir una página con `bc_open_page`.
2. Publicar una extensión AL sobre la misma sesión BC.
3. Business Central muestra el diálogo de cierre por cambio de extensión.
4. Intentar `bc_open_page` de nuevo.
5. Resultado observado en la primera llamada: `SESSION_LOST` / sesión recreada.
6. Reintentar `bc_open_page`.
7. Resultado observado en la segunda llamada: sesión conectada y página abierta correctamente.

### Resultado deseable

Documentar este patrón en el MCP: después de publicar una extensión, si aparece `Session was lost and has been recreated`, el cliente debe descartar los `pageContextId` antiguos y reintentar abriendo de nuevo las páginas necesarias.

---

## Estado actual al escribir este fichero

La reproducción todavía no está cerrada porque falta capturar el PDF/preview real.

Estado preparado:

- `GlobalBaseJBC` publicado temporalmente con la lógica antigua/buggy.
- Oferta `2000052` en `CRONUS_04` preparada y liberada.
- Condición del bug preparada:
  - envío = dirección de cliente;
  - facturación = dirección custom distinta.

Siguiente acción necesaria:

1. abrir `CRONUS_04` > `Sales Quote` > oferta `2000052`;
2. ejecutar `Print/Send > Print...`;
3. generar vista previa/PDF;
4. guardar evidencia del ANTES en `.screenshots/BC745/antes_real_bug.*`;
5. reaplicar fix AL;
6. compilar/publicar;
7. repetir exactamente la misma impresión y guardar `.screenshots/BC745/despues_real_fix.*`.
