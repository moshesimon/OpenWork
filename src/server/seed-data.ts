import {
  AutonomyLevel,
  ConversationType,
  Prisma,
  PrismaClient,
  SenderMode,
} from "@prisma/client";

type DbClient = Prisma.TransactionClient | PrismaClient;
type CalendarEventDelegate = {
  deleteMany(args?: unknown): Promise<unknown>;
  createMany(args: unknown): Promise<unknown>;
};

type CalendarEventAttendeeDelegate = {
  deleteMany(args?: unknown): Promise<unknown>;
  createMany(args: unknown): Promise<unknown>;
};

export const SEEDED_USERS = [
  { id: "u_alex", displayName: "Alex Park", avatarColor: "#3B82F6" },
  { id: "u_brooke", displayName: "Brooke Lane", avatarColor: "#EF4444" },
  { id: "u_carmen", displayName: "Carmen Diaz", avatarColor: "#14B8A6" },
  { id: "u_diego", displayName: "Diego Moss", avatarColor: "#F97316" },
  { id: "u_erin", displayName: "Erin Shaw", avatarColor: "#22C55E" },
] as const;

export const SEEDED_CHANNELS = [
  { id: "ch_general", slug: "general", name: "general" },
  { id: "ch_build", slug: "build", name: "build" },
  { id: "ch_design", slug: "design", name: "design" },
] as const;

export const SEEDED_CHANNEL_CONVERSATIONS = [
  { id: "conv_ch_general", channelId: "ch_general" },
  { id: "conv_ch_build", channelId: "ch_build" },
  { id: "conv_ch_design", channelId: "ch_design" },
] as const;

export const SEEDED_DM_CONVERSATIONS = [
  { id: "conv_dm_alex_brooke", dmUserAId: "u_alex", dmUserBId: "u_brooke" },
  { id: "conv_dm_carmen_erin", dmUserAId: "u_carmen", dmUserBId: "u_erin" },
  { id: "conv_dm_brooke_diego", dmUserAId: "u_brooke", dmUserBId: "u_diego" },
] as const;

type SeedMessageInput = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  minutesAgo: number;
};

type SeedCalendarEventInput = {
  id: string;
  ownerId: string;
  createdById: string;
  title: string;
  description: string;
  location: string;
  startOffsetMinutes: number;
  durationMinutes: number;
  allDay?: boolean;
};

const SEEDED_MESSAGE_INPUTS: SeedMessageInput[] = [
  {
    id: "msg_seed_general_01",
    conversationId: "conv_ch_general",
    senderId: "u_alex",
    body: "Week goal: ship Orion beta on Friday. Please flag blockers early.",
    minutesAgo: 300,
  },
  {
    id: "msg_seed_general_02",
    conversationId: "conv_ch_general",
    senderId: "u_brooke",
    body: "Frontend status: command bar and briefing feed are in QA.",
    minutesAgo: 294,
  },
  {
    id: "msg_seed_general_03",
    conversationId: "conv_ch_general",
    senderId: "u_erin",
    body: "Need final attribution copy by Thursday noon for mobile layouts.",
    minutesAgo: 288,
  },
  {
    id: "msg_seed_general_04",
    conversationId: "conv_ch_general",
    senderId: "u_carmen",
    body: "Heads up: staging queue latency spiked to 2.3s overnight.",
    minutesAgo: 282,
  },
  {
    id: "msg_seed_general_05",
    conversationId: "conv_ch_general",
    senderId: "u_diego",
    body: "I can run a load test after lunch, share latest endpoint list.",
    minutesAgo: 276,
  },
  {
    id: "msg_seed_general_06",
    conversationId: "conv_ch_general",
    senderId: "u_alex",
    body: "@Carmen please prioritize queue latency, this is a blocker for beta.",
    minutesAgo: 270,
  },
  {
    id: "msg_seed_general_07",
    conversationId: "conv_ch_general",
    senderId: "u_carmen",
    body: "Root cause found: missing index on agent_event_logs.createdAt.",
    minutesAgo: 264,
  },
  {
    id: "msg_seed_general_08",
    conversationId: "conv_ch_general",
    senderId: "u_carmen",
    body: "Patch merged, p95 is now 420ms. Please recheck bootstrap timing.",
    minutesAgo: 258,
  },
  {
    id: "msg_seed_general_09",
    conversationId: "conv_ch_general",
    senderId: "u_brooke",
    body: "Saw two 500s on /api/agent/commands when provider key was missing.",
    minutesAgo: 252,
  },
  {
    id: "msg_seed_general_10",
    conversationId: "conv_ch_general",
    senderId: "u_alex",
    body: "Let's show a friendlier fallback notice in the briefing feed.",
    minutesAgo: 246,
  },
  {
    id: "msg_seed_general_11",
    conversationId: "conv_ch_general",
    senderId: "u_erin",
    body: "Posted updated mobile spacing in Figma. Feedback welcome.",
    minutesAgo: 240,
  },
  {
    id: "msg_seed_general_12",
    conversationId: "conv_ch_general",
    senderId: "u_diego",
    body: "Customer Success asked for a summary template for exec updates.",
    minutesAgo: 234,
  },
  {
    id: "msg_seed_general_13",
    conversationId: "conv_ch_general",
    senderId: "u_alex",
    body: "Good call. AI should summarize top 3 risks each morning.",
    minutesAgo: 228,
  },
  {
    id: "msg_seed_general_14",
    conversationId: "conv_ch_general",
    senderId: "u_brooke",
    body: "Need final copy for 'sent as me by AI' attribution line.",
    minutesAgo: 222,
  },
  {
    id: "msg_seed_general_15",
    conversationId: "conv_ch_general",
    senderId: "u_erin",
    body: "Drafted copy: Use <user name>'s AI for attribution.",
    minutesAgo: 216,
  },
  {
    id: "msg_seed_general_16",
    conversationId: "conv_ch_general",
    senderId: "u_alex",
    body: "Ship it. Freeze copy by 4pm today.",
    minutesAgo: 210,
  },
  {
    id: "msg_seed_build_01",
    conversationId: "conv_ch_build",
    senderId: "u_carmen",
    body: "Deploy #781 started for agent routing fixes.",
    minutesAgo: 205,
  },
  {
    id: "msg_seed_build_02",
    conversationId: "conv_ch_build",
    senderId: "u_diego",
    body: "CI is failing on integration tests due hardcoded seed assumptions.",
    minutesAgo: 198,
  },
  {
    id: "msg_seed_build_03",
    conversationId: "conv_ch_build",
    senderId: "u_brooke",
    body: "Pushed a fix so seed IDs are stable for demos.",
    minutesAgo: 191,
  },
  {
    id: "msg_seed_build_04",
    conversationId: "conv_ch_build",
    senderId: "u_carmen",
    body: "New warning: provider timeout fallback triggered under load.",
    minutesAgo: 184,
  },
  {
    id: "msg_seed_build_05",
    conversationId: "conv_ch_build",
    senderId: "u_alex",
    body: "For demo we default to Claude Haiku 4.5. Keep mock fallback active.",
    minutesAgo: 177,
  },
  {
    id: "msg_seed_build_06",
    conversationId: "conv_ch_build",
    senderId: "u_diego",
    body: "Load test: /api/bootstrap median 180ms, p95 390ms.",
    minutesAgo: 170,
  },
  {
    id: "msg_seed_build_07",
    conversationId: "conv_ch_build",
    senderId: "u_carmen",
    body: "One blocker remains: SQLite write lock on send + proactive analysis.",
    minutesAgo: 163,
  },
  {
    id: "msg_seed_build_08",
    conversationId: "conv_ch_build",
    senderId: "u_brooke",
    body: "Can we batch event log inserts in one transaction?",
    minutesAgo: 156,
  },
  {
    id: "msg_seed_build_09",
    conversationId: "conv_ch_build",
    senderId: "u_carmen",
    body: "Implemented transaction path, lock errors disappeared.",
    minutesAgo: 149,
  },
  {
    id: "msg_seed_build_10",
    conversationId: "conv_ch_build",
    senderId: "u_diego",
    body: "Need synthetic data with realistic chatter to demo AI relevance.",
    minutesAgo: 142,
  },
  {
    id: "msg_seed_build_11",
    conversationId: "conv_ch_build",
    senderId: "u_alex",
    body: "Let's seed launch planning, incidents, and design coordination.",
    minutesAgo: 135,
  },
  {
    id: "msg_seed_build_12",
    conversationId: "conv_ch_build",
    senderId: "u_brooke",
    body: "Adding unread signals for Alex in #build for the demo.",
    minutesAgo: 128,
  },
  {
    id: "msg_seed_build_13",
    conversationId: "conv_ch_build",
    senderId: "u_carmen",
    body: "Done. All checks green. Please run setup before rehearsal.",
    minutesAgo: 121,
  },
  {
    id: "msg_seed_build_14",
    conversationId: "conv_ch_build",
    senderId: "u_alex",
    body: "Thanks team. Demo rehearsal starts at 5pm sharp.",
    minutesAgo: 114,
  },
  {
    id: "msg_seed_design_01",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Shared v3 of briefing cards with importance chips.",
    minutesAgo: 108,
  },
  {
    id: "msg_seed_design_02",
    conversationId: "conv_ch_design",
    senderId: "u_brooke",
    body: "Looks strong. Can we tighten vertical rhythm on mobile?",
    minutesAgo: 102,
  },
  {
    id: "msg_seed_design_03",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Yes, reduced card padding from 20 to 16.",
    minutesAgo: 96,
  },
  {
    id: "msg_seed_design_04",
    conversationId: "conv_ch_design",
    senderId: "u_alex",
    body: "Need an icon for low-confidence suggest-only state.",
    minutesAgo: 90,
  },
  {
    id: "msg_seed_design_05",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Added amber icon and tooltip copy for review.",
    minutesAgo: 84,
  },
  {
    id: "msg_seed_design_06",
    conversationId: "conv_ch_design",
    senderId: "u_diego",
    body: "Please include source message links in each briefing card footer.",
    minutesAgo: 78,
  },
  {
    id: "msg_seed_design_07",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Added source pills for channel and sender.",
    minutesAgo: 72,
  },
  {
    id: "msg_seed_design_08",
    conversationId: "conv_ch_design",
    senderId: "u_brooke",
    body: "Can we support long summaries without layout shift?",
    minutesAgo: 66,
  },
  {
    id: "msg_seed_design_09",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Applied max-height and fade; expands on click.",
    minutesAgo: 60,
  },
  {
    id: "msg_seed_design_10",
    conversationId: "conv_ch_design",
    senderId: "u_alex",
    body: "Great direction. Keep visual language calm and low-noise.",
    minutesAgo: 54,
  },
  {
    id: "msg_seed_design_11",
    conversationId: "conv_ch_design",
    senderId: "u_erin",
    body: "Uploaded final assets to /design/agent-feed.",
    minutesAgo: 48,
  },
  {
    id: "msg_seed_design_12",
    conversationId: "conv_ch_design",
    senderId: "u_brooke",
    body: "Merged styling polish into main.",
    minutesAgo: 42,
  },
  {
    id: "msg_seed_dm_ab_01",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_alex",
    body: "Can you tighten Agent Command Bar spacing before the demo?",
    minutesAgo: 58,
  },
  {
    id: "msg_seed_dm_ab_02",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_brooke",
    body: "Yes. I also want a clearer disabled state while commands run.",
    minutesAgo: 52,
  },
  {
    id: "msg_seed_dm_ab_03",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_alex",
    body: "Perfect, keep it subtle and avoid extra visual noise.",
    minutesAgo: 46,
  },
  {
    id: "msg_seed_dm_ab_04",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_brooke",
    body: "Desktop is done. Mobile still wraps placeholder text awkwardly.",
    minutesAgo: 40,
  },
  {
    id: "msg_seed_dm_ab_05",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_alex",
    body: "This is urgent for rehearsal. Need the fix by 3pm today.",
    minutesAgo: 34,
  },
  {
    id: "msg_seed_dm_ab_06",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_brooke",
    body: "Patched with shorter hint copy and responsive width.",
    minutesAgo: 28,
  },
  {
    id: "msg_seed_dm_ab_07",
    conversationId: "conv_dm_alex_brooke",
    senderId: "u_alex",
    body: "Great, thank you. I will call this out in standup.",
    minutesAgo: 22,
  },
  {
    id: "msg_seed_dm_ce_01",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_carmen",
    body: "Need a quick incident graphic for the queue latency postmortem.",
    minutesAgo: 56,
  },
  {
    id: "msg_seed_dm_ce_02",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_erin",
    body: "I can share in 20 minutes. Which metrics matter most?",
    minutesAgo: 50,
  },
  {
    id: "msg_seed_dm_ce_03",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_carmen",
    body: "Use p95 from 2.3s down to 0.42s after the index fix.",
    minutesAgo: 44,
  },
  {
    id: "msg_seed_dm_ce_04",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_erin",
    body: "Done. Added before/after chart and short caption.",
    minutesAgo: 38,
  },
  {
    id: "msg_seed_dm_ce_05",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_carmen",
    body: "Looks good. This explains urgency without blame.",
    minutesAgo: 32,
  },
  {
    id: "msg_seed_dm_ce_06",
    conversationId: "conv_dm_carmen_erin",
    senderId: "u_erin",
    body: "Published in #design references for the deck.",
    minutesAgo: 26,
  },
  {
    id: "msg_seed_dm_bd_01",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_brooke",
    body: "Can you rerun the agent command regression pack?",
    minutesAgo: 53,
  },
  {
    id: "msg_seed_dm_bd_02",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_diego",
    body: "Running now. One flaky assertion in briefing order.",
    minutesAgo: 47,
  },
  {
    id: "msg_seed_dm_bd_03",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_brooke",
    body: "Is that deterministic sort or timestamp precision?",
    minutesAgo: 41,
  },
  {
    id: "msg_seed_dm_bd_04",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_diego",
    body: "Timestamp precision. I normalized to ms and reran.",
    minutesAgo: 35,
  },
  {
    id: "msg_seed_dm_bd_05",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_brooke",
    body: "Nice. Please push so demo runs are stable.",
    minutesAgo: 29,
  },
  {
    id: "msg_seed_dm_bd_06",
    conversationId: "conv_dm_brooke_diego",
    senderId: "u_diego",
    body: "Pushed and CI is green.",
    minutesAgo: 23,
  },
];

const SEEDED_CALENDAR_EVENT_INPUTS: SeedCalendarEventInput[] = [
  {
    id: "evt_alex_planning_sync",
    ownerId: "u_alex",
    createdById: "u_alex",
    title: "Launch planning sync",
    description: "Review blockers and assign owners for Orion beta launch.",
    location: "Zoom",
    startOffsetMinutes: 180,
    durationMinutes: 45,
  },
  {
    id: "evt_alex_design_review",
    ownerId: "u_alex",
    createdById: "u_alex",
    title: "Design QA review",
    description: "Review mobile spacing and briefing card polish.",
    location: "Design room B",
    startOffsetMinutes: 24 * 60 + 120,
    durationMinutes: 60,
  },
  {
    id: "evt_alex_demo_rehearsal",
    ownerId: "u_alex",
    createdById: "u_alex",
    title: "Demo rehearsal",
    description: "Full dry run with AI routing and calendar flow.",
    location: "War room",
    startOffsetMinutes: 2 * 24 * 60 + 60,
    durationMinutes: 90,
  },
  {
    id: "evt_brooke_backend_triage",
    ownerId: "u_brooke",
    createdById: "u_brooke",
    title: "Backend triage",
    description: "Triage failing integration tests and flaky workflows.",
    location: "Huddle",
    startOffsetMinutes: 150,
    durationMinutes: 30,
  },
  {
    id: "evt_carmen_perf_check",
    ownerId: "u_carmen",
    createdById: "u_carmen",
    title: "Performance check-in",
    description: "Validate queue latency after indexing patch.",
    location: "Ops channel",
    startOffsetMinutes: 4 * 24 * 60 + 90,
    durationMinutes: 30,
  },
  {
    id: "evt_erin_copy_review",
    ownerId: "u_erin",
    createdById: "u_erin",
    title: "Copy review",
    description: "Finalize AI attribution strings before freeze.",
    location: "Figma call",
    startOffsetMinutes: 6 * 24 * 60 + 180,
    durationMinutes: 45,
  },
  {
    id: "evt_diego_load_test",
    ownerId: "u_diego",
    createdById: "u_diego",
    title: "Load test run",
    description: "Synthetic traffic run with seeded chatter scenarios.",
    location: "Staging",
    startOffsetMinutes: 3 * 24 * 60 + 150,
    durationMinutes: 60,
  },
];

function atMinutesAgo(now: number, minutesAgo: number): Date {
  return new Date(now - minutesAgo * 60 * 1000);
}

function atMinutesFromNow(now: number, offsetMinutes: number): Date {
  return new Date(now + offsetMinutes * 60 * 1000);
}

function getCalendarEventDelegate(db: DbClient): CalendarEventDelegate {
  const delegate = (db as { calendarEvent?: unknown }).calendarEvent;

  if (!delegate) {
    throw new Error("Calendar model is unavailable on this Prisma client.");
  }

  return delegate as CalendarEventDelegate;
}

function getCalendarEventAttendeeDelegate(db: DbClient): CalendarEventAttendeeDelegate {
  const delegate = (db as { calendarEventAttendee?: unknown }).calendarEventAttendee;

  if (!delegate) {
    throw new Error("Calendar attendee model is unavailable on this Prisma client.");
  }

  return delegate as CalendarEventAttendeeDelegate;
}

export async function resetDatabase(db: DbClient): Promise<void> {
  const calendarEvent = getCalendarEventDelegate(db);
  const calendarEventAttendee = getCalendarEventAttendeeDelegate(db);
  await calendarEventAttendee.deleteMany();
  await calendarEvent.deleteMany();
  await db.agentEventLog.deleteMany();
  await db.briefingItem.deleteMany();
  await db.outboundDelivery.deleteMany();
  await db.agentAction.deleteMany();
  await db.agentTask.deleteMany();
  await db.agentPolicyRule.deleteMany();
  await db.userRelevanceProfile.deleteMany();
  await db.agentProfile.deleteMany();
  await db.readState.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channel.deleteMany();
  await db.user.deleteMany();
}

export async function seedDatabase(db: DbClient): Promise<void> {
  const calendarEvent = getCalendarEventDelegate(db);
  const calendarEventAttendee = getCalendarEventAttendeeDelegate(db);

  await db.user.createMany({
    data: SEEDED_USERS.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
    })),
  });

  await db.channel.createMany({
    data: SEEDED_CHANNELS.map((channel) => ({
      id: channel.id,
      slug: channel.slug,
      name: channel.name,
    })),
  });

  await db.conversation.createMany({
    data: SEEDED_CHANNEL_CONVERSATIONS.map((conversation) => ({
      id: conversation.id,
      type: ConversationType.CHANNEL,
      channelId: conversation.channelId,
    })),
  });

  await db.conversation.createMany({
    data: SEEDED_DM_CONVERSATIONS.map((conversation) => ({
      id: conversation.id,
      type: ConversationType.DM,
      dmUserAId: conversation.dmUserAId,
      dmUserBId: conversation.dmUserBId,
    })),
  });

  const now = Date.now();
  const seededMessages = SEEDED_MESSAGE_INPUTS.map((entry) => ({
    id: entry.id,
    conversationId: entry.conversationId,
    senderId: entry.senderId,
    body: entry.body,
    createdAt: atMinutesAgo(now, entry.minutesAgo),
  }));

  await db.message.createMany({ data: seededMessages });

  const channelReadStateRows = SEEDED_CHANNEL_CONVERSATIONS.flatMap((conversation) =>
    SEEDED_USERS.map((user) => {
      let minutesAgo = 1;

      if (user.id === "u_alex" && conversation.id === "conv_ch_build") {
        minutesAgo = 140;
      } else if (user.id === "u_alex" && conversation.id === "conv_ch_general") {
        minutesAgo = 250;
      } else if (user.id === "u_brooke" && conversation.id === "conv_ch_design") {
        minutesAgo = 80;
      } else if (user.id === "u_diego" && conversation.id === "conv_ch_general") {
        minutesAgo = 200;
      }

      return {
        conversationId: conversation.id,
        userId: user.id,
        lastReadAt: atMinutesAgo(now, minutesAgo),
      };
    }),
  );

  const dmReadStateRows = [
    {
      conversationId: "conv_dm_alex_brooke",
      userId: "u_alex",
      lastReadAt: atMinutesAgo(now, 30),
    },
    {
      conversationId: "conv_dm_alex_brooke",
      userId: "u_brooke",
      lastReadAt: atMinutesAgo(now, 24),
    },
    {
      conversationId: "conv_dm_carmen_erin",
      userId: "u_carmen",
      lastReadAt: atMinutesAgo(now, 34),
    },
    {
      conversationId: "conv_dm_carmen_erin",
      userId: "u_erin",
      lastReadAt: atMinutesAgo(now, 22),
    },
    {
      conversationId: "conv_dm_brooke_diego",
      userId: "u_brooke",
      lastReadAt: atMinutesAgo(now, 33),
    },
    {
      conversationId: "conv_dm_brooke_diego",
      userId: "u_diego",
      lastReadAt: atMinutesAgo(now, 21),
    },
  ];

  await db.readState.createMany({
    data: [...channelReadStateRows, ...dmReadStateRows],
  });

  await db.agentProfile.createMany({
    data: SEEDED_USERS.map((user) => ({
      userId: user.id,
      defaultAutonomyLevel: AutonomyLevel.AUTO,
      senderMode: SenderMode.USER_AI_TAG,
      settingsJson: {
        proactiveEnabled: true,
        aiAttribution: true,
        demoScenario: "launch_week",
      },
      lastAnalysisAt: atMinutesAgo(now, 10),
    })),
  });

  await db.userRelevanceProfile.createMany({
    data: SEEDED_USERS.map((user) => ({
      userId: user.id,
      priorityPeopleJson: [user.id],
      priorityChannelsJson: ["ch_general"],
      priorityTopicsJson: ["shipping", "blocker", "urgent"],
      urgencyKeywordsJson: ["urgent", "asap", "blocker", "today"],
      mutedTopicsJson: ["social", "random"],
    })),
  });

  await db.agentPolicyRule.createMany({
    data: SEEDED_USERS.map((user) => ({
      userId: user.id,
      scopeType: "all",
      scopeKey: "*",
      autonomyLevel: AutonomyLevel.AUTO,
    })),
  });

  await calendarEvent.createMany({
    data: SEEDED_CALENDAR_EVENT_INPUTS.map((event) => {
      const startAt = atMinutesFromNow(now, event.startOffsetMinutes);
      const endAt = atMinutesFromNow(
        now,
        event.startOffsetMinutes + event.durationMinutes,
      );

      return {
        id: event.id,
        ownerId: event.ownerId,
        createdById: event.createdById,
        title: event.title,
        description: event.description,
        location: event.location,
        startAt,
        endAt,
        allDay: Boolean(event.allDay),
      };
    }),
  });

  await calendarEventAttendee.createMany({
    data: SEEDED_CALENDAR_EVENT_INPUTS.map((event) => ({
      eventId: event.id,
      userId: event.ownerId,
    })),
  });
}
