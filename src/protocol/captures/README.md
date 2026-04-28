# Wire-format captures

Frozen wire payloads used as test fixtures. Each file is sanitised: any session
keys / IDs replaced with `"REDACTED"`. The capture script
(`scripts/capture-tell-me.ts`) emits each file with a small metadata wrapper:

```json
{
  "capturedAt": "<ISO timestamp>",
  "query": "<query string>",
  "formId": "<BC form id>",
  "events": [ ...BCEvent[] ]
}
```

Tests should read `events`; the wrapper exists for human auditability of when /
what was captured.

## Files

| File | Source | Date | Notes |
|---|---|---|---|
| `tell-me-result-2026-04-28.json` | BC28 default profile, Tell Me query `customer` (and `items`, `sales`, `general` as fallbacks) | 2026-04-28 | EMPTY-RESULT capture: BC produced only `InvokeCompleted`, no `DataLoaded`. Documents limits.md #5 (Tell Me returns empty on default profile). |

## Tell Me row layout (2026-04-28, BC28 default profile)

DataLoaded event shape (from `src/protocol/types.ts`):

```ts
{
  type: 'DataLoaded',
  formId: string,
  controlPath: string,
  currentRowOnly: boolean,
  rows: unknown[]
}
```

When a Tell Me search has hits, each row in `rows[]` is expected to follow the
shape used elsewhere in BC's wire format:

```json
{
  "DataRowInserted": [
    <indexOrBookmark>,
    {
      "cells": {
        "<binder1>": "<caption-text>",
        "<binder2>": "<page-id-string>",
        "<binder3>": "<object-type>"
      },
      "bookmark": "<optional bookmark>"
    }
  ]
}
```

Cell binders are server-generated names like `1234567_c1`. Stable within one
Tell Me session, but not across sessions. The extractor must therefore read
cell values by position (`Object.values(cells)` insertion order), not by binder
name. Expected positional layout is `[caption, objectId, objectType]` (caption
is the user-visible name, objectId is digits for Pages and a non-numeric
identifier for non-Page hits, objectType is a label like `"Page"`, `"Report"`,
`"Codeunit"`, ...).

NOTE: this row layout is the inferred shape from the existing
`extractSearchResults` heuristic in `src/services/search-service.ts`. It has
not been verified against a populated DataLoaded payload because the BC28
default profile in our env returns no Tell Me hits at all (see below).
A future capture against a profile that produces Tell Me hits should be added
here and this section updated with the actually-observed binder names and cell
values.

## Empty-result observation (this capture)

Run details:

- `BC_BASE_URL=http://Cronus28/BC`, default profile, NavUserPassword auth.
- Queries tried in order: `customer`, `items`, `sales`, `general`. None
  produced any `DataLoaded` event.
- Each query produced exactly 1 event: `InvokeCompleted` (sequenceNumber 2,
  durationMs 0).
- The Tell Me form itself did open successfully (verified by `FormCreated`
  event during the open step), so the protocol is wired correctly; BC simply
  has no indexed search hits for these queries on this profile.
- This matches the symptom documented in `limits.md` #5.

The fixture is therefore the canonical empty-result wire response and is the
right input for testing the empty-result code path of the Tell Me extractor.
