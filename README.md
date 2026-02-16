# Thin Slack (Channels + DMs)

Local-only thin Slack clone built with:
- Next.js (App Router, TypeScript)
- Prisma + SQLite
- API routes under `src/app/api`
- Seeded users and channels, DM auto-create, manual refresh flow

## Features
- No auth; active user chosen from UI dropdown (`x-user-id` sent to API).
- Public channels and direct messages.
- Send + history only (no edit/delete/reactions).
- Latest 50 messages + load older pagination.
- Manual refresh with unread badges.
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
3. Initialize database and seed test users/channels:
```bash
npm run setup
```
`setup` recreates the local SQLite file and reseeds data.
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

## API Endpoints
- `GET /api/bootstrap`
- `GET /api/conversations/:conversationId/messages?cursor=&limit=`
- `POST /api/conversations/:conversationId/messages`
- `POST /api/conversations/:conversationId/read`
- `GET /api/dms/:otherUserId/messages?cursor=&limit=`
- `POST /api/dms/:otherUserId/messages`

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
- No websocket/polling: users only see updates after pressing refresh.
