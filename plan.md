# Thin Slack (Channels + DMs) Build Plan (Local-Only)

## Summary
Goal: build a thin Slack clone with full frontend + backend + DB, supporting only:
- hardcoded users (no auth),
- public seeded channels,
- 1:1 DMs (auto-created on first message),
- send + history messaging,
- manual refresh with unread badges,
- a persistent context document for future chats.

Success criteria:
- Active user can be switched from a header dropdown.
- Channel and DM messages persist in DB.
- Other users see updates after pressing refresh.
- Unread badges are accurate.
- Latest 50 messages load first, with load-older pagination.
- UI works on desktop and mobile.
- A `PROJECT_CONTEXT.md` file exists and is kept updated for future chat sessions.

## Scope
In scope:
- Single Next.js TypeScript app with API routes and SQLite.
- Slack-like 3-pane UI.
- Seeded channels; runtime DM creation.
- Project context documentation in markdown for future sessions.

Out of scope:
- Real auth, private channels, channel creation, edit/delete, reactions, file uploads, threads, presence, websocket realtime.

## Architecture
- App: single Next.js App Router project in `/Users/moshesimon/GitHub/OpenWork`.
- Backend: route handlers under `/app/api`.
- DB: Prisma + SQLite (`prisma/dev.db`).
- Identity: frontend sends `x-user-id` on each request; backend validates against seeded users.
- Sync mode: manual refresh only.

## Data Model (Prisma)
- `User`: `id`, `displayName`, `avatarColor`, `createdAt`
- `Channel`: `id`, `slug`, `name`, `createdAt`
- `Conversation`: `id`, `type` (`CHANNEL|DM`), `channelId?`, `dmUserAId?`, `dmUserBId?`, `createdAt`
- `Message`: `id`, `conversationId`, `senderId`, `body`, `createdAt`
- `ReadState`: `conversationId`, `userId`, `lastReadAt` (unique pair)

Rules:
- Seed 5 users and 3 channels.
- Create one `Conversation` per seeded channel.
- No pre-seeded DMs; create on first DM send/read.
- Canonical DM pair ordering (`min(userId), max(userId)`) to prevent duplicate DM threads.
- Message body max 2000 chars.

## API Interfaces
All endpoints require `x-user-id`.

1. `GET /api/bootstrap`
- Returns users, channels, DMs, unread counts, last message previews, active user profile.

2. `GET /api/conversations/:conversationId/messages?cursor=<messageId>&limit=50`
- Cursor pagination for message history.

3. `POST /api/conversations/:conversationId/messages`
- Body: `{ "body": "..." }`
- Creates message in channel or existing DM conversation.

4. `GET /api/dms/:otherUserId/messages?cursor=&limit=50`
- Finds or creates DM conversation, returns messages.

5. `POST /api/dms/:otherUserId/messages`
- Body: `{ "body": "..." }`
- Finds or creates DM conversation, writes message.

6. `POST /api/conversations/:conversationId/read`
- Marks current conversation as read (`lastReadAt=now`).

Error shape (all endpoints):
- `{ "errorCode": "...", "message": "..." }`
- Status codes: `400`, `404`, `413`, `500`.

## Frontend Plan
- 3-pane Slack-like layout:
- Left: user selector.
- Middle: channels and DMs with unread badges + last preview.
- Right: message timeline, composer, refresh button, load older.
- Mobile: collapsible list pane + focused message pane.

State behavior:
- Initial load -> `GET /api/bootstrap`.
- Select conversation -> fetch latest 50 + mark read.
- Send message -> optimistic append + reconcile response.
- Click refresh -> reload bootstrap + active conversation.
- Persist selected user and last opened conversation in `localStorage`.

## Implementation Sequence
1. Scaffold Next.js + TypeScript + Prisma + test tooling.
2. Define Prisma schema and run initial migration.
3. Add seed script for users/channels/conversations/messages.
4. Implement shared server utilities:
- user resolution from header,
- DM conversation resolver,
- unread count computation,
- cursor pagination.
5. Build all API routes.
6. Build 3-pane frontend and responsive navigation.
7. Add read-state and refresh badge logic.
8. Add error handling + empty/loading states.
9. Final polish and runbook (`README`).
10. Create `PROJECT_CONTEXT.md` with architecture, setup commands, API map, schema summary, seeded test users/channels, and known constraints.
11. Add a maintenance rule: update `PROJECT_CONTEXT.md` whenever APIs, schema, scripts, or key workflows change.

## Context File Spec (`PROJECT_CONTEXT.md`)
Purpose:
- Give any new chat/session enough project context to contribute immediately.

Required sections:
1. Project snapshot:
- What the app does, MVP scope, and current non-goals.
2. Tech stack:
- Framework, runtime, DB, ORM, testing tools, and key scripts.
3. Runbook:
- `npm install`, env setup, DB setup/seed, dev server, lint, tests, build.
4. Architecture map:
- Main folders and responsibilities (`src/app`, `src/app/api`, `src/server`, `prisma`).
5. Data model summary:
- `User`, `Channel`, `Conversation`, `Message`, `ReadState` and key constraints.
6. API reference:
- Endpoint list, required headers, request/response notes, and validation/error behavior.
7. Seed and local test identities:
- Hardcoded users/channels and intended usage for manual QA.
8. Product behavior:
- Manual refresh model, unread badge behavior, pagination, DM auto-create rule.
9. Current status and open tasks:
- What is implemented and what is intentionally deferred.
10. Update protocol:
- Checklist for keeping context accurate after each meaningful change.

Quality bar:
- Keep concise but complete.
- Prefer exact file paths and script names.
- Update in the same PR/commit as behavior changes.

## Tests and Scenarios
Automated:
1. Unit: DM auto-create canonicalization, unread count logic, pagination boundaries.
2. Integration: bootstrap payload correctness, channel send/read flow, DM first-send auto-create, read endpoint clearing unread.
3. E2E: switch user, send from User A, refresh as User B, verify unread and message visibility; verify load-older.

Manual acceptance:
1. Switch through all 5 users and send messages in channels and DMs.
2. Confirm unread badges update only after refresh.
3. Confirm active thread marks read.
4. Confirm mobile navigation can open channel/DM and send.

## Assumptions and Defaults
- Local-only development target.
- SQLite as persistent source of truth.
- Public seeded channels only.
- 1:1 DMs only.
- Plain-text messages only.
- Manual refresh is the only cross-client sync mechanism.
