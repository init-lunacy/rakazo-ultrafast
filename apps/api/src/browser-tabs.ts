import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import { BrowserTabsSchema } from "@rakazo/contracts";
import type { Prisma, ThreadEvents } from "@rakazo/db";

/** A client or a transaction: the thread snapshot reads this inside its own. */
type Db = Pick<Prisma.TransactionClient, "run" | "event">;

/** Runs back to look for a tab list: a newer run that has not browsed must not hide it. */
const RECENT_RUNS = 10;

async function latestRunTabs(db: Db, botId: string) {
  const runs = await db.run.findMany({
    where: { botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RECENT_RUNS,
    select: { id: true, threadId: true },
  });
  if (runs.length === 0) return undefined;
  // The tabs and the pin outlive the run that opened them: a new message's run has
  // published nothing yet, and the strip, Follow included, must stay meanwhile.
  const event = await db.event.findFirst({
    where: { runId: { in: runs.map((run) => run.id) }, type: "computer.browser_tabs" },
    orderBy: { createdAt: "desc" },
    select: { payload: true, runId: true },
  });
  const run = runs.find((candidate) => candidate.id === event?.runId);
  const parsed = BrowserTabsSchema.safeParse(event?.payload);
  return run && parsed.success
    ? { runId: run.id, threadId: run.threadId, tabs: parsed.data }
    : undefined;
}

/** The tab strip as the bot's latest browsing run left it, or nothing. */
export async function latestBrowserTabs(db: Db, botId: string): Promise<BrowserTabs | undefined> {
  return (await latestRunTabs(db, botId))?.tabs;
}

/**
 * Pin the viewer to a tab, or unpin with `target: null`, and record the result
 * where the strip reads it. The computer holds the pin; this only echoes it.
 */
export async function showBrowserTab(
  deps: {
    prisma: Db;
    sandbox: Pick<SandboxProvider, "pageBrowser">;
    events: Pick<ThreadEvents, "append">;
  },
  input: { spaceId: string; botId: string; computer: ComputerRef; target: string | null },
  context: AdapterContext,
): Promise<void> {
  if (!deps.sandbox.pageBrowser) return;
  const reply = await deps.sandbox.pageBrowser(
    input.computer,
    { command: "activate", target: input.target, pin: input.target !== null },
    context,
  );
  if (!reply.ok) return;
  const latest = await latestRunTabs(deps.prisma, input.botId);
  if (!latest) return;
  await deps.events.append({
    spaceId: input.spaceId,
    threadId: latest.threadId,
    botId: input.botId,
    type: "computer.browser_tabs",
    runId: latest.runId,
    // The latest run may have been cancelled; its tab list is still the screen's.
    allowCancelledRun: true,
    payload: {
      ...latest.tabs,
      front: typeof reply.front === "string" ? reply.front : latest.tabs.front,
      pinned: typeof reply.pinned === "string" ? reply.pinned : null,
    },
  });
}
