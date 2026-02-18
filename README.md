# Thin Slack (Channels + DMs)

Local-only thin Slack clone built with:
- Next.js (App Router, TypeScript)
- Prisma + SQLite
- API routes under `src/app/api`
- Seeded users and channels, DM auto-create, automatic background sync
- Agent orchestration layer with pluggable providers (`anthropic`, `openai`, `mock`) powered by Vercel AI SDK
- Trigger.dev tasks for command/proactive/bootstrap orchestration

## Features
- No auth; active user chosen from UI dropdown (`x-user-id` sent to API).
- Public channels and direct messages.
- Send + history only (no edit/delete/reactions).
- Latest 50 messages + load older pagination.
- Automatic background refresh with unread badges.
- Workspace Calendar tab with Outlook-style month grid + day agenda.
- AI command support for calendar event create/update/delete/query.
- Responsive 3-pane layout with mobile drawer behavior.

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

All endpoints require `x-user-id` header.

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
