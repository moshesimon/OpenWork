# Unified Agent Redesign Plan (Single Hive-Brain)

Last updated: 2026-02-18

## Goal
Move from two orchestration loops (`runAgentCommand` + `runProactiveAnalysis`) to one unified agent runtime that can be triggered by:

1. User messages.
2. System events (for example inbound DM/channel messages).

The same runtime should decide whether to:
- send a DM/channel message,
- create/update tasks/events,
- post an AI chat message to the user,
- create a briefing item,
- or take no action.

## Current State (Summary)
- User-command path:
  - `/Users/moshesimon/GitHub/OpenWork/src/app/api/agent/commands/route.ts`
  - `/Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts` -> `runAgentCommand`
- Event/proactive path:
  - `/Users/moshesimon/GitHub/OpenWork/src/app/api/dms/[otherUserId]/messages/route.ts`
  - `/Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/messages/route.ts`
  - `/Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts` -> `runProactiveAnalysis`
- Shared context already exists in:
  - `/Users/moshesimon/GitHub/OpenWork/src/agent/context-pack.ts`

## Target Architecture

### Core
Single orchestrator entrypoint, for example:
- `runAgentTurn(db, input: AgentTurnRequest): Promise<AgentTurnResult>`

Where `AgentTurnRequest` includes:
- `userId`
- `trigger`:
  - `type: "USER_MESSAGE" | "SYSTEM_EVENT"`
  - payload details (message text, source message id, conversation id, sender id, etc.)
- optional `contextHints`
- optional `idempotencyKey`

### Behavioral Model
- One shared tool registry for both trigger types.
- One policy layer (autonomy, routing, approval gates).
- One context pack.
- Trigger type changes objectives/priority, not which agent exists.

### Output Model
Explicit output actions from one turn:
- `SEND_MESSAGE`
- `WRITE_AI_CHAT_MESSAGE`
- `CREATE_BRIEFING`
- `LOG_ONLY`
- plus existing task/calendar actions

## Constraints
- Keep compatibility during migration (wrappers can call unified path).
- Preserve existing APIs while internals are moved.
- Keep deterministic idempotency protections for event-triggered runs.

## Session-by-Session Plan

## Session 1: Contracts and Scaffolding
### Objective
Introduce the unified turn contract without changing production behavior.

### Changes
- Add request/response types for unified turns in orchestrator module (or a dedicated types file).
- Add trigger discriminated union:
  - `USER_MESSAGE` payload.
  - `SYSTEM_EVENT` payload.
- Add no-op `runAgentTurn` skeleton that delegates to existing flows.

### Exit Criteria
- Types compile.
- Existing tests pass unchanged.
- No route behavior changes yet.

### Prompt for Next Chat
Implement Session 1 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Keep behavior identical and only add unified contracts + delegating `runAgentTurn`.

## Session 2: Shared Runtime Extraction
### Objective
Extract common runtime internals so both old flows use the same engine.

### Changes
- Extract shared pieces from `runAgentCommand` + `runProactiveAnalysis`:
  - context load,
  - tool registration,
  - provider execution,
  - task/event logging helpers,
  - error and timeout handling.
- Build one runtime function that accepts trigger config and objective hints.

### Exit Criteria
- Both legacy wrappers call shared runtime.
- Existing command/proactive behavior remains functionally equivalent.

### Prompt for Next Chat
Implement Session 2 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Refactor to shared runtime internals while preserving API behavior.

## Session 3: Unified Tooling for Notifications
### Objective
Allow a system event turn to explicitly choose between AI chat note, briefing, direct send, or no-op.

### Changes
- Add explicit tool/action for writing assistant chat messages.
- Ensure unified runtime exposes same send/message/task/calendar tools for both trigger types.
- Update proactive instructions/objectives to prefer dedupe-aware behavior.

### Exit Criteria
- Event-triggered turns can produce AI chat output through tools.
- No duplicate briefing/message creation for same source event.

### Prompt for Next Chat
Implement Session 3 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Add unified notification tools and ensure event-triggered turns can write to AI chat.

## Session 4: Route Integration (System Events)
### Objective
Switch DM/channel/bootstrap event routes to unified turn entrypoint.

### Changes
- Replace direct `runProactiveAnalysisJob` calls with unified job call.
- Map inbound message events into `trigger.type = "SYSTEM_EVENT"`.
- Preserve realtime publish behavior.

### Exit Criteria
- Event routes no longer call proactive-specific entrypoint.
- Integration tests pass for DM/channel event-triggered outcomes.

### Prompt for Next Chat
Implement Session 4 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Migrate DM/channel/bootstrap routes to unified `runAgentTurn` event trigger.

## Session 5: Route Integration (User Commands)
### Objective
Switch user command route to unified turn entrypoint.

### Changes
- `/api/agent/commands` calls unified job with `trigger.type = "USER_MESSAGE"`.
- Keep current chat persistence semantics (user+assistant messages), now sourced from unified turn output.
- Preserve mention/context-hint handling.

### Exit Criteria
- Command route no longer calls command-specific entrypoint.
- Existing command tests pass.

### Prompt for Next Chat
Implement Session 5 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Migrate `/api/agent/commands` to unified turn trigger while preserving current API response shape.

## Session 6: Idempotency and Dedup Hardening
### Objective
Guarantee event safety under retries/race conditions.

### Changes
- Add stable idempotency key strategy for system events.
- Enforce dedupe at DB and runtime layers:
  - task-level dedupe by `(userId, sourceMessageId/sourceEventId, actionKind)` where appropriate.
- Keep current duplicate-briefing safeguards and extend if gaps remain.

### Exit Criteria
- Replayed event does not create duplicate user-facing outputs.
- New regression tests for replay/race cases pass.

### Prompt for Next Chat
Implement Session 6 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Harden idempotency for unified event-triggered turns and add replay/race regression tests.

## Session 7: Cleanup and Deprecation
### Objective
Remove split-brain artifacts after unified path is stable.

### Changes
- Deprecate/remove old wrappers:
  - `runAgentCommand`
  - `runProactiveAnalysis`
  - old trigger job names if replaced
- Rename logs/events for unified terminology where needed.
- Update docs and context files.

### Exit Criteria
- No production route depends on old split entrypoints.
- Docs reflect one-agent architecture.

### Prompt for Next Chat
Implement Session 7 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Remove deprecated split entrypoints and finalize docs for unified agent architecture.

## Session 8: Final Validation and Rollout
### Objective
Complete end-to-end confidence checks and rollout guardrails.

### Changes
- Add/verify E2E scenarios:
  - user command -> action execution,
  - inbound DM event -> dedupe-aware AI decision,
  - event can produce AI chat note without duplicate briefings.
- Add metrics/log fields for trigger type and chosen action mix.
- Add feature flag fallback if needed.

### Exit Criteria
- All tests passing.
- Clear rollback strategy documented.
- Ready for default-on in dev/staging.

### Prompt for Next Chat
Implement Session 8 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
Run full validation and prepare rollout notes + fallback controls.

## Per-Session Handoff Template
At the end of each session, append this to your chat output and update this file:

1. Completed session number and title.
2. Files changed (absolute paths).
3. Tests run and outcomes.
4. Known risks or TODOs.
5. Exact next session prompt from this plan.

## Definition of Done (Full Redesign)
- One unified turn entrypoint handles both user and system triggers.
- Routes call unified entrypoint only.
- Shared tool/policy/context runtime.
- Event-triggered decisions are context-aware and dedupe-safe.
- AI can choose chat note, briefing, direct action, or no-op from one runtime.
- Documentation and tests reflect the single-agent design.

## Session Handoff Log

### Session 1: Contracts and Scaffolding (Completed 2026-02-18)
1. Completed session number and title.
   Session 1: Contracts and Scaffolding.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
3. Tests run and outcomes.
   - `npm run test -- src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed: 3 files, 9 tests)
   - `npx eslint src/agent/orchestrator.ts` (passed)
4. Known risks or TODOs.
   - `runAgentTurn` currently delegates to legacy wrappers; routes are not migrated yet.
5. Exact next session prompt from this plan.
   Implement Session 2 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Refactor to shared runtime internals while preserving API behavior.

### Session 2: Shared Runtime Extraction (Completed 2026-02-18)
1. Completed session number and title.
   Session 2: Shared Runtime Extraction.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
3. Tests run and outcomes.
   - `npm run test -- src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed: 3 files, 9 tests)
   - `npx eslint src/agent/orchestrator.ts` (passed)
4. Known risks or TODOs.
   - Unified output actions are still implicit tool-side effects; Session 3 should introduce explicit notification actions.
   - Full-project `npx tsc --noEmit` remains red in this repo due pre-existing missing test runner globals in test files.
5. Exact next session prompt from this plan.
   Implement Session 3 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Add unified notification tools and ensure event-triggered turns can write to AI chat.

### Session 5: Route Integration (User Commands) (Completed 2026-02-18)
1. Completed session number and title.
   Session 5: Route Integration (User Commands).
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/agent/commands/route.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/agent/commands/route.unit.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/trigger/client.ts
   - /Users/moshesimon/GitHub/OpenWork/src/trigger/agent-tasks.ts
3. Tests run and outcomes.
   - `npm run test -- src/app/api/agent/commands/route.unit.test.ts src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed: 4 files, 12 tests)
   - `npx eslint src/app/api/agent/commands/route.ts src/app/api/agent/commands/route.unit.test.ts src/trigger/client.ts src/trigger/agent-tasks.ts` (passed)
4. Known risks or TODOs.
   - System-event routes still use `runProactiveAnalysisJob`; Session 4 route migration remains pending if not completed separately.
   - `runAgentTurn` still delegates to legacy wrappers internally until later cleanup/deprecation sessions.
5. Exact next session prompt from this plan.
   Implement Session 6 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Harden idempotency for unified event-triggered turns and add replay/race regression tests.

### Session 6: Idempotency and Dedup Hardening (Completed 2026-02-18)
1. Completed session number and title.
   Session 6: Idempotency and Dedup Hardening.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/prisma/schema.prisma
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.proactive.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/server/seed-data.ts
3. Tests run and outcomes.
   - `npm run prisma:generate` (passed)
   - `npm run test -- src/agent/orchestrator.proactive.integration.test.ts src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/app/api/agent/commands/route.unit.test.ts` (passed: 4 files, 17 tests)
   - `npx eslint src/agent/orchestrator.ts src/agent/orchestrator.proactive.integration.test.ts src/server/seed-data.ts src/trigger/client.ts src/trigger/agent-tasks.ts src/app/api/agent/commands/route.ts src/app/api/agent/commands/route.unit.test.ts` (passed)
4. Known risks or TODOs.
   - New DB tables (`AgentSystemTurnIdempotency`, `AgentProactiveOutputDedup`) require schema apply (`npm run db:push` or rebuild) in persistent local/dev DBs.
   - System-event routes still need Session 4 unified route migration in the integration branch.
5. Exact next session prompt from this plan.
   Implement Session 7 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Remove deprecated split entrypoints and finalize docs for unified agent architecture.

### Session 3: Unified Tooling for Notifications (Completed 2026-02-18)
1. Completed session number and title.
   Session 3: Unified Tooling for Notifications.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/provider/mock.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.proactive.integration.test.ts
3. Tests run and outcomes.
   - `npm run test -- src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed: 3 files, 11 tests)
   - `npx eslint src/agent/orchestrator.ts src/agent/provider/mock.ts src/agent/orchestrator.proactive.integration.test.ts` (passed)
4. Known risks or TODOs.
   - System event routes still call `runProactiveAnalysisJob`; Session 4 route migration to unified entrypoint remains pending.
   - Tool parity between command and proactive flows is currently maintained in code but still duplicated in places; later cleanup can consolidate shared tool builders.
5. Exact next session prompt from this plan.
   Implement Session 4 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Migrate DM/channel/bootstrap routes to unified `runAgentTurn` event trigger.

### Session 4: Route Integration (System Events) (Completed 2026-02-18)
1. Completed session number and title.
   Session 4: Route Integration (System Events).
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/dms/[otherUserId]/messages/route.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/messages/route.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/dms/[otherUserId]/messages/route.unit.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/conversations/[conversationId]/messages/route.unit.test.ts
3. Tests run and outcomes.
   - `npm run test -- src/app/api/dms/[otherUserId]/messages/route.unit.test.ts src/app/api/conversations/[conversationId]/messages/route.unit.test.ts src/app/api/agent/commands/route.unit.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed: 4 files, 12 tests)
   - `npx eslint src/app/api/dms/[otherUserId]/messages/route.ts src/app/api/conversations/[conversationId]/messages/route.ts src/agent/orchestrator.ts src/app/api/dms/[otherUserId]/messages/route.unit.test.ts src/app/api/conversations/[conversationId]/messages/route.unit.test.ts` (passed)
4. Known risks or TODOs.
   - `runAgentTurn` still delegates to `runProactiveAnalysis` for system events; full wrapper cleanup remains for later deprecation sessions.
   - Compatibility wrappers (`runProactiveAnalysisJob` / proactive Trigger task) are intentionally retained for migration safety and can be removed in cleanup.
5. Exact next session prompt from this plan.
   Implement Session 5 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Migrate `/api/agent/commands` to unified turn trigger while preserving current API response shape.

### Session 7: Cleanup and Deprecation (Completed 2026-02-18)
1. Completed session number and title.
   Session 7: Cleanup and Deprecation.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
   - /Users/moshesimon/GitHub/OpenWork/src/trigger/client.ts
   - /Users/moshesimon/GitHub/OpenWork/src/trigger/agent-tasks.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/[id]/act/route.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.tasks.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.calendar.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.proactive.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/app/api/briefings/[id]/act/route.unit.test.ts
   - /Users/moshesimon/GitHub/OpenWork/README.md
   - /Users/moshesimon/GitHub/OpenWork/PROJECT_CONTEXT.md
3. Tests run and outcomes.
   - `npm run test -- src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts src/app/api/agent/commands/route.unit.test.ts src/app/api/dms/[otherUserId]/messages/route.unit.test.ts src/app/api/conversations/[conversationId]/messages/route.unit.test.ts src/app/api/briefings/[id]/act/route.unit.test.ts` (passed: 7 files, 25 tests)
   - `npx eslint src/trigger/agent-tasks.ts src/trigger/client.ts src/app/api/briefings/[id]/act/route.ts src/app/api/briefings/[id]/act/route.unit.test.ts src/agent/orchestrator.ts src/agent/orchestrator.tasks.integration.test.ts src/agent/orchestrator.calendar.integration.test.ts src/agent/orchestrator.proactive.integration.test.ts` (passed)
4. Known risks or TODOs.
   - Legacy Trigger task IDs (`agent-run-command`, `agent-run-proactive-analysis`) are removed from code paths; if any external automation still references them, those external callers must migrate to `agent-run-turn`.
   - Historical session log entries above are out of chronological order from prior chats; functional state now reflects the unified entrypoint.
5. Exact next session prompt from this plan.
   Implement Session 8 from `/Users/moshesimon/GitHub/OpenWork/UNIFIED_AGENT_REDESIGN_PLAN.md`.
   Run full validation and prepare rollout notes + fallback controls.

### Session 8: Final Validation and Rollout (Completed 2026-02-18)
1. Completed session number and title.
   Session 8: Final Validation and Rollout.
2. Files changed (absolute paths).
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.ts
   - /Users/moshesimon/GitHub/OpenWork/src/trigger/client.ts
   - /Users/moshesimon/GitHub/OpenWork/.env.example
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.tasks.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/src/agent/orchestrator.proactive.integration.test.ts
   - /Users/moshesimon/GitHub/OpenWork/README.md
   - /Users/moshesimon/GitHub/OpenWork/PROJECT_CONTEXT.md
3. Tests run and outcomes.
   - `npm run test` (passed: 16 files, 54 tests)
   - `npm run lint` (passed with existing warnings only; 0 errors)
4. Known risks or TODOs.
   - Rollback guardrail is now `AGENT_SYSTEM_EVENT_TURNS_ENABLED=false` (disables system-event turns while preserving user-command turns); ensure production runbooks include this switch.
   - `npm run lint` still reports pre-existing warnings in unrelated files (`src/app/page.tsx`, `src/server/chat-service.ts`).
5. Exact next session prompt from this plan.
   N/A — Session 8 is the final session in this redesign plan.
