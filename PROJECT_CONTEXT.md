# Project Context: Thin Slack (Channels + DMs)

## 1. Project Snapshot
- Project type: local-only thin Slack clone.
- Product goal: support public channels and 1:1 DMs with persistent history.
- Implemented MVP scope:
- No auth; active identity selected in UI.
- Public seeded channels.
- DMs auto-created on first open/send.
- Send + history messages.
- Manual refresh model with unread badges.
- Latest-50 pagination with load older.
- Non-goals for current version:
- Private channels.
- Channel creation UI/API.
- Message edit/delete/reactions/files/threads/presence.
- Websocket or polling realtime.

## 2. Tech Stack
- Frontend/backend framework: Next.js 16 App Router (`/Users/moshesimon/GitHub/OpenWork/src/app`).
- Language: TypeScript.
- Database: SQLite (`DATABASE_URL="file:./prisma/dev.db"`).
- ORM: Prisma 7 with Better SQLite adapter.
- ORM adapter wiring: `/Users/moshesimon/GitHub/OpenWork/src/lib/prisma.ts`.
- Tests: Vitest.
- Lint: ESLint (Next config).

## 3. Runbook (Local Dev)
- Install deps:
```bash
npm install
```
- Configure env:
```bash
cp .env.example .env
```
- Initialize schema + seed:
```bash
npm run setup
```
- Start app:
```bash
npm run dev
```
- Quality checks:
```bash
npm run lint
npm test
npm run build
```

Important script behavior:
- `npm run db:push` deletes local DB artifacts and recreates schema from Prisma diff script.
- `npm run setup` is destructive for local data (recreates DB and reseeds).

## 4. Architecture Map
- App shell/UI:
- `/Users/moshesimon/GitHub/OpenWork/src/app/page.tsx`
- API routes:
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/bootstrap/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/messages/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/read/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/dms/[otherUserId]/messages/route.ts`
- Service/business logic:
- `/Users/moshesimon/GitHub/OpenWork/src/server/chat-service.ts`
- Seed and fixtures:
- `/Users/moshesimon/GitHub/OpenWork/src/server/seed-data.ts`
- `/Users/moshesimon/GitHub/OpenWork/prisma/seed.ts`
- Shared API helpers:
- `/Users/moshesimon/GitHub/OpenWork/src/lib/request.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/lib/api-error.ts`
- Prisma config and schema:
- `/Users/moshesimon/GitHub/OpenWork/prisma.config.ts`
- `/Users/moshesimon/GitHub/OpenWork/prisma/schema.prisma`

## 5. Data Model Summary
Schema file: `/Users/moshesimon/GitHub/OpenWork/prisma/schema.prisma`.

- `User`
- `id`, `displayName`, `avatarColor`, `createdAt`
- `Channel`
- `id`, `slug` (unique), `name`, `createdAt`
- `Conversation`
- `id`, `type` (`CHANNEL|DM`), `channelId?`, `dmUserAId?`, `dmUserBId?`, `createdAt`
- `Message`
- `id`, `conversationId`, `senderId`, `body`, `createdAt`
- `ReadState`
- Composite PK: `conversationId + userId`, plus `lastReadAt`

Key data rules:
- Channel conversations are seeded.
- DMs are not seeded; created on demand.
- DM pair canonicalization is done in service logic via sorted user IDs.
- Message max length: 2000 characters.

## 6. API Reference
Header requirement for all endpoints:
- `x-user-id: <seeded-user-id>`

Endpoints:
1. `GET /api/bootstrap`
- Returns active user, all users, channel list, DM list, unread counts, and last-message previews.

2. `GET /api/conversations/:conversationId/messages?limit=50&cursor=<messageId>`
- Returns `{ conversationId, messages[], nextCursor }`.

3. `POST /api/conversations/:conversationId/messages`
- JSON body: `{ "body": "..." }`
- Returns created message.

4. `POST /api/conversations/:conversationId/read`
- Marks conversation read for active user.

5. `GET /api/dms/:otherUserId/messages?limit=50&cursor=<messageId>`
- Finds or creates DM conversation and returns paged messages.

6. `POST /api/dms/:otherUserId/messages`
- JSON body: `{ "body": "..." }`
- Finds or creates DM conversation and creates message.

Validation/error behavior:
- Shared error shape: `{ "errorCode": "...", "message": "..." }`
- Common statuses: `400`, `404`, `413`, `500`
- Important error codes:
- `MISSING_USER_HEADER`
- `INVALID_JSON`
- `USER_NOT_FOUND`
- `CONVERSATION_NOT_FOUND`
- `INVALID_LIMIT`
- `INVALID_CURSOR`
- `INVALID_BODY`
- `EMPTY_BODY`
- `BODY_TOO_LARGE`
- `INVALID_DM_TARGET`
- `DM_TARGET_NOT_FOUND`
- `INTERNAL_ERROR`

## 7. Seed and Local Test Identities
Seed source: `/Users/moshesimon/GitHub/OpenWork/src/server/seed-data.ts`.

Users:
- `u_alex` (Alex Park)
- `u_brooke` (Brooke Lane)
- `u_carmen` (Carmen Diaz)
- `u_diego` (Diego Moss)
- `u_erin` (Erin Shaw)

Channels:
- `#general`
- `#build`
- `#design`

Seed behavior:
- Creates channel conversations with fixed IDs.
- Seeds starter messages in channels.
- Initializes `ReadState` for all users on all seeded channels.
- Does not pre-create DMs.

## 8. Product Behavior (Current)
- Active user can be switched via UI dropdown.
- Thread selection and active user are persisted in localStorage.
- URL is synchronized for shareable state:
- `?user=<userId>&thread=<channel|dm>&id=<threadId>`
- Selecting DM triggers auto-create if no conversation exists yet.
- Opening a thread marks it read.
- Sending message is optimistic in UI and reconciled with API response.
- Cross-user updates are visible only after pressing Refresh.
- Load older requests next page with cursor.

## 9. Current Status and Open Tasks
Implemented:
- Full frontend, backend, DB schema, seed flow, and API routes for channel/DM messaging.
- Manual refresh + unread counts + read-state updates.
- Pagination and message validation.
- Unit + integration tests for core service behavior.

Testing coverage currently present:
- Unit tests for helper logic.
- Integration tests for bootstrap, unread/read behavior, DM auto-create, and pagination.

Deferred/open work:
- E2E browser tests.
- Auth and authorization.
- Private channels/channel management.
- Realtime push (websockets/SSE).
- Rich messaging features (edit/delete/reactions/files/threads).

## 10. Update Protocol (Keep This File Accurate)
When behavior changes, update this file in the same commit/PR.

Checklist:
1. If scripts changed in `package.json`, update Runbook and script notes.
2. If schema changed in `prisma/schema.prisma`, update Data Model Summary and rules.
3. If routes or payloads changed in `src/app/api` or `src/types/chat.ts`, update API Reference.
4. If seed users/channels changed in `src/server/seed-data.ts`, update Seed section.
5. If UX behavior changed in `src/app/page.tsx`, update Product Behavior.
6. If test coverage changed, update Current Status and coverage notes.
7. Re-run `npm run lint && npm test && npm run build` and note any new constraints.
