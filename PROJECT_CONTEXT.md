# Project Context: Agent-First Work Productivity Platform

## 1. Strategic Direction
Project goal:
- Build the “Cursor for work productivity” by redesigning Slack around AI-mediated collaboration.

Core product principle:
- Users communicate intent to AI first.
- AI routes and drafts outbound communication to the right DM/channel.
- AI filters inbound communication into a personal relevance feed.

Implication:
- The thin Slack chat system remains the transport substrate.

## 2. Current Product State (Implemented)
Current implementation includes:
- Public channels + 1:1 DMs with seeded users/channels.
- Expanded demo seed conversations across channels and selected DM threads.
- Manual chat transport APIs and read-state/unread badges.
- Agent-first UI regions on `/Users/moshesimon/GitHub/OpenWork/src/app/page.tsx`:
  - Agent Command Bar
  - Personal Briefing Feed
  - Outlook-style Calendar tab (month grid + day agenda)
  - Delivery Trace Panel
  - Manual thread fallback panel
- Agent orchestration pipeline:
  - command ingestion
  - calendar event create/update/delete/query execution
  - routing
  - relevance scoring
  - proactive briefing creation
  - outbound execution + delivery logs

## 3. Product State Next (Near-Term)
Planned next steps:
1. Approval/review workflow for outbound sends (current default is autonomous path with policy overrides).
2. Better proactive follow-up actions (auto-reply/draft branching).
3. More complete integration/E2E coverage for agent flows.

## 4. Tech Stack
- Framework: Next.js 16 App Router.
- Language: TypeScript.
- DB: SQLite (`DATABASE_URL="file:./prisma/dev.db"`).
- ORM: Prisma 7 + `@prisma/adapter-better-sqlite3`.
- Test runner: Vitest.
- Lint: ESLint.
- AI provider layer: `anthropic` | `openai` | `mock` (implemented via Vercel AI SDK).
- Workflow runtime: Trigger.dev tasks (v3 SDK APIs).
- Optional external search adapters: Python FastAPI services under `agent_runtime/search_adapters`.
- Default provider selection: `AI_PROVIDER=anthropic`.
- Default Anthropic model: `ANTHROPIC_MODEL=claude-haiku-4-5`.

Key config files:
- `/Users/moshesimon/GitHub/OpenWork/package.json`
- `/Users/moshesimon/GitHub/OpenWork/prisma.config.ts`
- `/Users/moshesimon/GitHub/OpenWork/next.config.ts`
- `/Users/moshesimon/GitHub/OpenWork/.env.example`

## 5. Local Runbook
Install:
```bash
npm install
```

Env:
```bash
cp .env.example .env
```

Set key for Anthropic provider:
```bash
# .env
ANTHROPIC_API_KEY="..."
```
Optional Trigger.dev env for task dispatch:
```bash
# .env
TRIGGER_SECRET_KEY="..."
TRIGGER_PROJECT_REF="..."
```

Database init + seed:
```bash
npm run setup
```

Run app:
```bash
npm run dev
```

Validate:
```bash
npm run lint
npm test
npm run build
```

Important note:
- `npm run setup` performs an in-place schema sync (`prisma db push`) and reseeds baseline data.
- For a full local reset, use `npm run db:rebuild` followed by `npm run prisma:seed`.

## 6. Architecture Map
Frontend:
- `/Users/moshesimon/GitHub/OpenWork/src/app/page.tsx`
- `/Users/moshesimon/GitHub/OpenWork/src/app/globals.css`
- `/Users/moshesimon/GitHub/OpenWork/src/app/layout.tsx`

Chat transport routes:
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/bootstrap/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/messages/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/read/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/dms/[otherUserId]/messages/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/calendar/events/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/calendar/events/[eventId]/route.ts`

Agent routes:
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/agent/commands/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/agent/tasks/[taskId]/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/agent/profile/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/agent/policies/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/[id]/ack/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/[id]/dismiss/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/[id]/act/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/channels/route.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/dm/route.ts`

Core business logic:
- `/Users/moshesimon/GitHub/OpenWork/src/server/chat-service.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/server/calendar-service.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/server/agent-service.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/relevance.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/routing.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/policy-resolver.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/executor.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/logging.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/provider/anthropic.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/provider/openai.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/agent/provider/mock.ts`

Seed data:
- `/Users/moshesimon/GitHub/OpenWork/src/server/seed-data.ts`
- `/Users/moshesimon/GitHub/OpenWork/prisma/seed.ts`

Shared libs/types:
- `/Users/moshesimon/GitHub/OpenWork/src/lib/prisma.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/lib/request.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/lib/api-error.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/types/chat.ts`
- `/Users/moshesimon/GitHub/OpenWork/src/types/agent.ts`

Optional adapter services:
- `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/chatindex_api.py`
- `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/pageindex_api.py`

## 7. Data Model (Current)
Schema source:
- `/Users/moshesimon/GitHub/OpenWork/prisma/schema.prisma`

Core chat tables:
- `User`
- `Channel`
- `Conversation` (`CHANNEL|DM`)
- `Message`
- `ReadState`

Agent tables:
- `AgentProfile`
- `UserRelevanceProfile`
- `AgentPolicyRule`
- `AgentTask`
- `AgentAction`
- `OutboundDelivery`
- `BriefingItem`
- `AgentEventLog`

Workspace planning tables:
- `WorkspaceTask`
- `CalendarEvent`

Current important rules:
- DMs are created on demand (canonical user pair).
- Message body max length is 2000.
- Pagination defaults/caps at 50.
- Proactive agent pass uses a 2s budget and writes timeout/error state.

## 8. APIs (Current)
Most endpoints require:
- `x-user-id` header

Transport endpoints:
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

Search adapter endpoint auth notes:
- `POST /api/search/chatindex`: accepts `userId` in JSON body (also supports header fallback)
- `POST /api/search/pageindex`: no `x-user-id` requirement

Agent endpoints:
- `POST /api/agent/commands`
- `GET /api/agent/tasks/:taskId`
- `GET /api/agent/profile`
- `PUT /api/agent/profile`
- `GET /api/agent/policies`
- `PUT /api/agent/policies`
- `GET /api/briefings`
- `POST /api/briefings/:id/ack`
- `POST /api/briefings/:id/dismiss`
- `POST /api/briefings/:id/act`
- `POST /api/channels`
- `POST /api/conversations/dm`

Error contract:
- `{ "errorCode": string, "message": string }`

## 9. Seeded Local Identities
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

Pre-seeded DM threads:
- `u_alex` <-> `u_brooke`
- `u_carmen` <-> `u_erin`
- `u_brooke` <-> `u_diego`

## 10. Agent-First MVP v2 Status
Implemented baseline:
- Agent command ingestion and task/action/event persistence.
- Agent calendar intent handling (create/update/delete/query) with context retrieval.
- Provider abstraction with fallback behavior and Vercel AI SDK structured output + tools.
- Rule + model blended relevance scoring.
- Briefing feed APIs and status actions.
- Channel/DM creation primitives.
- Delivery trace retrieval via task API.
- Trigger.dev task dispatch for unified-turn/bootstrap flows.

Still limited in v2:
- No dedicated outbound draft-approval loop API yet.
- E2E coverage for full agent workflows is still light.

## 11. Guardrails and Operating Defaults
- Default autonomy seed is `AUTO`; policy rules can constrain behavior.
- Low-confidence handling favors notify/suggest over autonomous send.
- Manual transport endpoints remain available.
- Provider failures fall back to deterministic/mock behavior and are logged.
- Rollback guardrail: set `AGENT_SYSTEM_EVENT_TURNS_ENABLED=false` to pause inbound DM/channel/bootstrap-triggered turns while keeping user-command turns active.

## 12. Known Gaps
- Approval-gated send UX/API is not implemented yet.
- Multi-workspace, permissions, and enterprise controls are out of scope.
- Observability is persisted in DB logs but no dashboard surface exists yet.

## 13. Update Protocol
Whenever project behavior changes, update this file in the same commit.

Checklist:
1. If product direction changes, update Strategic Direction + Product State.
2. If scripts/config/env change, update Tech Stack + Runbook.
3. If APIs change, update API sections.
4. If schema changes, update Data Model.
5. If seed users/channels change, update Seeded Identities.
6. If major UX flows change, update Product State sections.
7. Re-run `npm run lint && npm test && npm run build` after substantive code changes.
