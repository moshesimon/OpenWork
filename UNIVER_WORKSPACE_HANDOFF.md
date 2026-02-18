# Univer Workspace Editor Handoff

Generated: 2026-02-18

## Goal
Integrate in-workspace Office-style document handling so users can:
- Edit `.xlsx` and `.docx` files inside the app using Univer.
- Keep `.pdf` files preview-only.
- Still show unsupported files in the sidebar and allow opening/downloading raw content.

## Current Capability Matrix
| Extension | UI Mode | Editable | Path |
|---|---|---:|---|
| `.txt`, `.md`, `.csv`, `.json`, `.yaml`, `.yml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.html`, `.css`, etc. | Text editor | Yes | `/api/workspace/file` |
| `.xlsx`, `.xls`, `.xlsm`, `.docx`, `.doc` | Univer editor | Yes | `/api/workspace/file/raw` + `WorkspaceUniverEditor` |
| `.pdf` | Embedded preview (`iframe`) | No | `/api/workspace/file/raw` |
| `.ppt`, `.pptx`, `.pps`, `.ppsx` and other binaries | Preview fallback (message + raw link) | No (in current build) | `/api/workspace/file/raw` |

Important: `.pptx` is intentionally listed/openable but not directly editable in this implementation.

## Where Workspace Files Live
Default workspace root:
- `company_files` (relative to repo root)

Config override:
- `WORKSPACE_FILES_ROOT` in `.env`

Implementation:
- `src/server/workspace-files.ts`

## Key Files (Read These First in a New Chat)
- `src/app/page.tsx`
  - Mode routing (`text` vs `univer` vs `pdf` vs preview)
  - Raw URL builder with `userId` query param
  - `WorkspaceUniverEditor` wiring and save callback
- `src/components/workspace-univer-editor.tsx`
  - Univer init/import/export/save lifecycle
  - Locale setup and mount/unmount safety guards
- `src/app/api/workspace/file/route.ts`
  - Text-edit file API + read-only messaging
- `src/app/api/workspace/file/raw/route.ts`
  - Binary GET/PUT for preview/download + Univer save-back
- `src/app/api/workspace/files/route.ts`
  - Directory/file listing behavior (shows unsupported files too)
- `src/server/workspace-files.ts`
  - Path normalization, content type, editability, workspace root
- `src/types/agent.ts`
  - `WorkspaceDocumentReadResponse` includes `contentType`
- `src/app/globals.css`
  - Univer CSS imports and container styles
- `.env.example`
  - Univer exchange env vars and workspace root docs

## Frontend Mode Selection Logic
In `src/app/page.tsx`:
- `resolveWorkspaceDocumentMode(document)` returns:
  - `"text"` when `document.editable === true`
  - `"pdf"` for `.pdf`
  - `"univer"` for `.xlsx/.xls/.xlsm/.docx/.doc`
  - `"preview"` otherwise

The raw file URL is built via:
- `buildWorkspaceFileRawUrl(path, userId)` -> `/api/workspace/file/raw?path=...&userId=...`

Reason for `userId` query support:
- Browser-driven resources like `iframe`/direct links cannot reliably attach custom `x-user-id` headers.

## APIs and Contracts

### 1) Text Adapter API
Path: `src/app/api/workspace/file/route.ts`

- `GET /api/workspace/file?path=...` (requires `x-user-id`)
  - Returns `WorkspaceDocumentReadResponse`
  - If not text-editable, returns `editable: false` + message
- `PUT /api/workspace/file` (requires `x-user-id`)
  - Body: `{ path, content, baseVersion? }`
  - Performs optimistic version check (`baseVersion`)

Limits:
- Max text-edit payload: `512_000` bytes (`MAX_EDITABLE_FILE_BYTES`)

### 2) Binary Raw API
Path: `src/app/api/workspace/file/raw/route.ts`

- `GET /api/workspace/file/raw?path=...&userId=...`
  - Auth accepted via either:
    - `x-user-id` header OR
    - `userId` query param
  - Returns raw bytes with:
    - `content-type`
    - `content-disposition: inline`
    - `x-workspace-file-version`
- `PUT /api/workspace/file/raw?path=...&baseVersion=...` (requires `x-user-id`)
  - Body: binary payload
  - Version conflict returns `409 FILE_VERSION_CONFLICT`

Limits:
- Max binary save payload: `20 MB` (`MAX_BINARY_FILE_BYTES`)

## Univer Integration Details
Component: `src/components/workspace-univer-editor.tsx`

Flow:
1. Determine kind:
   - `sheet` for `.xlsx/.xls/.xlsm`
   - `doc` for `.docx/.doc`
2. Dynamically import:
   - `@univerjs/presets`
   - `@univerjs/preset-sheets-core`
   - `@univerjs/preset-docs-core`
   - `@univerjs-pro/exchange-client`
3. Load locale packs and initialize Univer with locale/locales.
4. Import snapshot from raw URL (`/api/workspace/file/raw?...`).
5. Create workbook/doc in Univer.
6. On Save:
   - Export file from Univer facade API
   - `PUT` binary to `/api/workspace/file/raw` with `baseVersion`
   - Bubble save metadata up to `page.tsx` via `onSaved`

### Why Locale+Lifecycle Guarding Was Added
Previously seen runtime issues:
- `LocaleService not initialized`
- `Failed to execute 'removeChild' on 'Node'`
- `Can't perform a React state update on a component that hasn't mounted yet`

Fixes now in place:
- Explicit locale bootstrap (`enUS` packs for preset + exchange client)
- Avoid React children inside the DOM node Univer mutates
- `mountedRef` + `runIfMounted` guard for async state updates
- Defensive disposal wrapper around third-party teardown

## Env Vars for Univer Exchange
Documented in `.env.example`:
- `NEXT_PUBLIC_UNIVER_UPLOAD_FILE_URL`
- `NEXT_PUBLIC_UNIVER_IMPORT_URL`
- `NEXT_PUBLIC_UNIVER_EXPORT_URL`
- `NEXT_PUBLIC_UNIVER_TASK_URL`
- `NEXT_PUBLIC_UNIVER_SIGN_URL`
- `NEXT_PUBLIC_UNIVER_DOWNLOAD_ENDPOINT_URL`

If unset:
- Exchange client falls back to its same-origin defaults (typically requiring a compatible adapter path on the same host).

## Dependency Notes
Installed packages in `package.json`:
- `@univerjs/presets`
- `@univerjs/preset-sheets-core`
- `@univerjs/preset-docs-core`
- `@univerjs-pro/exchange-client`
- `@univerjs/slides` (present but slide editing is not wired end-to-end)

Global CSS imports required:
- `@univerjs/preset-sheets-core/lib/index.css`
- `@univerjs/preset-docs-core/lib/index.css`

## Known Gaps / Open Work
1. PPT/PPTX in-editor editing is not implemented.
   - Current behavior is listing + open raw + read-only messaging.
2. No dedicated converter/adapter orchestration for non-supported binary formats beyond raw preview/open.
3. `GET /api/workspace/file/raw` currently validates presence of user identity but does not verify identity semantics against sessions (consistent with current app-wide lightweight auth model).

## Suggested Next Steps (If Continuing)
1. Add slide import/export adapter path for `.pptx` and wire a `slide` mode in `WorkspaceUniverEditor`.
2. Add integration tests for `/api/workspace/file/raw`:
   - version conflict
   - max payload rejection
   - query/header identity handling
3. Add e2e UI tests for mode routing:
   - text editor
   - Univer editor
   - PDF preview
   - preview fallback
4. Consider server-side lock/version strategy beyond mtime for higher write concurrency safety.

## Quick Validation Commands
- `npx tsc --noEmit --types vitest/globals,node`
- `npx eslint src/components/workspace-univer-editor.tsx`
- `npm run build`

## Prompt Snippet for New Chat
Use this to bootstrap the next chat quickly:

```text
Read UNIVER_WORKSPACE_HANDOFF.md and continue from there.
Focus on [your next item], keep .xlsx/.docx editing via Univer working,
keep PDF preview-only, and preserve raw-file fallback for unsupported formats.
```
