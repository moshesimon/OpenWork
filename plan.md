# Agent-First Work Productivity Platform Plan (Slack Redesign)

## Product Vision
Build the “Cursor for work productivity” by redesigning Slack around an AI agent interface.

Core interaction model:
- Users primarily talk to AI (intent-first), not directly to channels/DM threads.
- AI translates intent into outbound communication to the right people/channels.
- AI continuously ingests inbound messages and proactively delivers only relevant updates to each user.

## Problem Statement
Current chat tools force users to:
- Manually decide where and how to communicate.
- Read high-volume channels to find personally relevant information.
- Context-switch between many threads and notifications.

This product should replace that with:
- AI-mediated communication routing.
- Personalized relevance filtering.
- Proactive, concise “what you need to know” updates.

## North-Star Outcomes
1. Reduce manual messaging effort.
2. Reduce irrelevant message consumption.
3. Improve response quality and speed with AI-drafted communication.
4. Keep users in a personal “briefing + actions” loop rather than channel-scanning.

## Current Baseline (Already Implemented)
The codebase currently provides a thin Slack foundation:
- Next.js app with channel/DM messaging, SQLite + Prisma.
- Manual thread UI and message send/history.
- Unread/read-state and pagination.
- Seed users/channels for local testing.

This baseline now becomes infrastructure for the agent-first layer.

## Target Product Scope (MVP v2)
In scope:
- Agent command experience (single primary input).
- Intent parsing + message routing to channels/DMs.
- AI draft + user approval flow (send, edit, cancel).
- Personal relevance feed (AI summaries of inbound activity).
- Proactive AI notifications for important updates.
- Delivery log with transparency (“what AI sent, where, and why”).

Out of scope (for this MVP v2):
- Multi-workspace tenancy.
- Advanced permissioning and enterprise compliance controls.
- Full autonomous mode without user guardrails.
- Voice/video meeting integrations.

## UX Principles
1. Agent-first default:
- Primary action is “Tell AI what you want to achieve.”

2. Human control:
- AI can draft by default; user can require approval before sending.
- Every AI action is inspectable and reversible where possible.

3. Relevance over volume:
- Users consume personalized briefings, not raw channel firehose.

4. Explainability:
- AI should show rationale for routing/summarization decisions.

## Proposed Architecture Additions
Keep existing app + DB, add agent orchestration layer.

New backend modules:
- `intent-service`: classify user instruction into actions (inform, ask, follow up, summarize).
- `routing-service`: select destination channels/users from org graph + history.
- `draft-service`: generate outbound message drafts.
- `briefing-service`: summarize inbound activity per user relevance profile.
- `agent-execution-service`: runs tool actions and logs each step.

New frontend surfaces:
- Agent Command Bar (global input).
- Outbound Review Panel (drafts + send approvals).
- Personal Briefing Feed (proactive updates).
- Action Queue (recommended follow-ups).
- Delivery Log/Trace (auditability).

## Data Model Extensions (Planned)
Add new tables while reusing current `User/Channel/Conversation/Message/ReadState`.

1. `AgentTask`
- user request to AI, lifecycle state, timestamps.

2. `AgentAction`
- normalized actions AI intends to take (send message, summarize, notify).

3. `OutboundDraft`
- drafted content + target metadata + approval status.

4. `OutboundDelivery`
- final sent message mapping to conversation/message IDs.

5. `UserRelevanceProfile`
- preferences, role signals, topic tags, priority rules.

6. `BriefingItem`
- AI-generated per-user update cards with source links.

7. `AgentEventLog`
- execution trace for transparency/debugging.

## API Plan (New Endpoints)
Agent commands:
- `POST /api/agent/commands`
- submit user intent text and optional constraints.

Draft review:
- `GET /api/agent/tasks/:taskId`
- `POST /api/agent/drafts/:draftId/approve`
- `POST /api/agent/drafts/:draftId/reject`
- `POST /api/agent/drafts/:draftId/edit-and-approve`

Briefings:
- `GET /api/briefings`
- `POST /api/briefings/:id/ack`

Transparency:
- `GET /api/agent/logs?taskId=`

Existing messaging APIs remain available as underlying transport.

## MVP v2 Flows
1. Outbound intent flow:
- User: “Tell design we’re shipping Friday, ask for final assets by Thursday.”
- AI: identifies recipients/channels, generates drafts, requests approval.
- User approves.
- AI sends messages and records deliveries + rationale.

2. Inbound relevance flow:
- New channel/DM messages arrive.
- AI evaluates relevance to user profile.
- AI creates briefing items for relevant updates only.
- User sees concise feed + suggested actions.

3. Follow-up flow:
- AI detects unanswered requests.
- AI suggests or drafts follow-up messages.

## Safety and Control Defaults
- Default mode: AI requires user approval before external sends.
- Include per-user toggle for auto-send in low-risk contexts later.
- Every sent message must be attributable to task + approval trail.
- Hard limits on send frequency to prevent spam loops.

## Implementation Sequence
1. Product framing in code:
- Add explicit “agent-first mode” docs and feature flags.

2. Schema evolution:
- Add agent-related tables (`AgentTask`, `AgentAction`, `OutboundDraft`, `BriefingItem`, logs).

3. Command ingestion:
- Implement `POST /api/agent/commands` with deterministic placeholder planner first.

4. Draft + approval loop:
- Build review UI and approve/reject APIs.

5. Delivery integration:
- Connect approved drafts to existing messaging service layer.

6. Relevance pipeline (initial rules-based):
- Start with heuristic relevance scoring before full LLM scoring.

7. Briefing UI:
- Personal feed with source links and acknowledgement.

8. Observability:
- Delivery log + task/action traces.

9. AI quality improvements:
- Introduce better intent/routing/summarization models incrementally.

10. End-to-end test scenarios for command -> draft -> send -> briefing loops.

## Testing Strategy
Unit:
- intent parsing normalization.
- routing selection rules.
- relevance scoring behavior.
- approval state transitions.

Integration:
- command submission creates task/actions/drafts.
- approve draft sends message and logs delivery.
- inbound messages generate expected briefing items.

E2E:
- user command to AI, approve send, recipient sees message.
- inbound org chatter produces concise personal briefing.
- action trace is visible for each AI-mediated send.

## Success Metrics (Initial)
1. % outbound messages sent through agent path vs manual compose.
2. Median time from user intent to delivered message.
3. Reduction in raw-thread reading time (self-reported or usage proxy).
4. Briefing precision (user marks “useful” vs “not useful”).
5. Follow-up completion rate on AI-suggested actions.

## Assumptions and Defaults
- Local-first development remains default.
- Existing thin Slack implementation is the transport/data foundation.
- Agent features initially run with conservative approval controls.
- Quality will improve iteratively from heuristic to stronger AI-based routing/relevance.

## Documentation and Context Rule
- Keep `/Users/moshesimon/GitHub/OpenWork/PROJECT_CONTEXT.md` updated as source-of-truth context for future chats.
- Any API/schema/flow change for agent-first features must update context docs in the same commit.
