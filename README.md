# Thin Slack (Channels + DMs)

Local-only thin Slack clone built with:
- Next.js (App Router, TypeScript)
- Prisma + SQLite
- API routes under `src/app/api`
- Seeded users and channels, DM auto-create, automatic background sync
- Agent orchestration layer with pluggable providers (`anthropic`, `openai`, `mock`) powered by Vercel AI SDK
- Trigger.dev tasks for unified-turn/bootstrap orchestration

## Features
- No auth; active user chosen from UI dropdown (`x-user-id` sent to API).
- Public channels and direct messages.
- Send + history only (no edit/delete/reactions).
- Latest 50 messages + load older pagination.
- Automatic background refresh with unread badges.
- Workspace Calendar tab with Outlook-style month grid + day agenda.
- AI command support for calendar event create/update/delete/query.
- Responsive 3-pane layout with mobile drawer behavior.
- Global search across channels, DMs, messages, tasks, calendar events, users, and company files.

## Setup
1. Install dependencies:
```bash
npm install
```
2. Configure env:
```bash
cp .env.example .env
```
Set your provider key (Anthropic default):
```bash
# in .env
ANTHROPIC_API_KEY="..."
```
Optional Trigger.dev setup (recommended for async orchestration):
```bash
# in .env
TRIGGER_SECRET_KEY="..."
TRIGGER_PROJECT_REF="..."
# Optional safety rollback for inbound DM/channel/bootstrap turns:
# AGENT_SYSTEM_EVENT_TURNS_ENABLED="false"
```
3. Initialize database and seed test users/channels:
```bash
npm run setup
```
`setup` syncs schema changes into the local SQLite DB and reseeds baseline demo data.
For a full DB reset, run `npm run db:rebuild` and then `npm run prisma:seed`.
4. Start dev server:
```bash
npm run dev
```
5. Open [http://localhost:3000](http://localhost:3000)

## Seeded Users
- `u_alex` (Alex Park)
- `u_brooke` (Brooke Lane)
- `u_carmen` (Carmen Diaz)
- `u_diego` (Diego Moss)
- `u_erin` (Erin Shaw)

## Seeded Demo Conversations
- Realistic multi-message scenarios are preloaded in `#general`, `#build`, and `#design`.
- Pre-seeded DM threads exist for:
  - `u_alex` <-> `u_brooke`
  - `u_carmen` <-> `u_erin`
  - `u_brooke` <-> `u_diego`
- Read states are intentionally staggered so unread badges and relevance flows are visible in demos.

## API Endpoints
- `GET /api/bootstrap`
- `GET /api/conversations/:conversationId/messages?cursor=&limit=`
- `POST /api/conversations/:conversationId/messages`
- `POST /api/conversations/:conversationId/read`
- `GET /api/dms/:otherUserId/messages?cursor=&limit=`
- `POST /api/dms/:otherUserId/messages`
- `GET /api/calendar/events?start=&end=&search=&limit=`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/:eventId`
- `DELETE /api/calendar/events/:eventId`
- `GET /api/search/global?q=&limit=`
- `POST /api/search/chatindex` (`{ query, userId?, limit? }`)
- `POST /api/search/pageindex` (`{ query, limit? }`)

All app endpoints require `x-user-id` header except `/api/search/pageindex` and `/api/search/chatindex` adapter endpoints (which accept `userId` in the JSON body and also support header fallback).

## Optional Python Search Adapters (FastAPI)
- Install adapter dependencies:
```bash
npm run search:adapters:install
```
- Run ChatIndex adapter (`http://localhost:8101/search`):
```bash
npm run search:chatindex:api
```
- Run PageIndex adapter (`http://localhost:8102/search`):
```bash
npm run search:pageindex:api
```
- Run OfficeIndex adapter (`http://localhost:8103/search`):
```bash
npm run search:officeindex:api
```
- Trigger full OfficeIndex reindex:
```bash
npm run search:officeindex:reindex:full
```
- Trigger incremental OfficeIndex reindex:
```bash
npm run search:officeindex:reindex:incremental
```
- Or run all adapters:
```bash
npm run search:adapters:run
```

When running adapters, set in `.env`:
- `CHATINDEX_SEARCH_URL="http://localhost:8101/search"`
- `PAGEINDEX_SEARCH_URL="http://localhost:8102/search"`
- `OFFICEINDEX_SEARCH_URL="http://localhost:8103/search"` (Phase 2 wiring in global search)

Optional OfficeIndex controls in `.env`:
- `OFFICEINDEX_REFRESH_INTERVAL_SECONDS="25"`
- `OFFICEINDEX_BACKGROUND_SYNC_SECONDS="0"` (enable periodic incremental refresh when > 0)

## Validation Rules
- Message body is required after trim.
- Message max length is 2000 chars.
- Page limit defaults to 50 and caps at 50.

## Test Commands
- Run all tests:
```bash
npm test
```
- Run linter:
```bash
npm run lint
```

## Project Notes
- DM conversation IDs are canonicalized by sorted user pair.
- Read state stored per `conversationId + userId`.
- No websocket transport: data is refreshed automatically via SSE push plus polling/focus sync fallback.
- Unified agent runtime entrypoint is `runAgentTurn` for both user commands and system events.
