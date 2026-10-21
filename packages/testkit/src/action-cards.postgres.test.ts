import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CapturingNotificationProvider } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import type { App, Bot } from "./app-helpers.js";
import { botInput, rpc, setBotIntroHarness, signup } from "./app-helpers.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("action cards (PostgreSQL)", () => {
  let handles: AppHandles;
  let app: App;
  let owner: string;
  let botId: string;
  const notifications = new CapturingNotificationProvider();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-cards-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      notifications,
    });
    app = handles.app;
    setBotIntroHarness(handles);
    owner = await signup(app, `cards-${stamp}@rakazo.test`, "Cards Owner");
    // Signup creates no bot; bots/create discards the intro run.
    botId = (await rpc<Bot>(app, owner, "bots/create", botInput("Card Bot"))).id;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function runUntilDone(runId: string) {
    for (let i = 0; i < 100; i++) {
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("run did not finish");
  }

  /** Pushes about this bot's chat only, so other suites' runs cannot leak in. */
  const pushes = (kind: string) =>
    notifications.sent.filter((message) => message.kind === kind && message.botId === botId);

  it("shows a card a run offered, and a tap starts its task as a new run", async () => {
    const sent = await rpc<{ runId: string }>(app, owner, "threads/send", {
      botId,
      text: 'offer the card "Book the hotel" to "Book the Lisbon hotel we compared."',
    });
    expect((await runUntilDone(sent.runId)).status).toBe("completed");
    const [card] = await rpc<Array<{ id: string; label: string; messageId: string }>>(
      app,
      owner,
      "actionOffers/list",
    );
    expect(card).toMatchObject({ label: "Book the hotel" });
    const nav = await rpc<{ current: { bots: Array<{ id: string; openOfferCount?: number }> } }>(
      app,
      owner,
      "spaces/list",
    );
    expect(nav.current.bots.find((bot) => bot.id === botId)?.openOfferCount).toBe(1);
    const taken = await rpc<{ runId?: string }>(app, owner, "actionOffers/take", {
      offerId: card!.id,
    });
    expect(taken.runId).toEqual(expect.any(String));
    const run = await handles.prisma.run.findUniqueOrThrow({
      where: { id: taken.runId! },
      include: { task: true },
    });
    expect(run.task.prompt).toContain("Book the Lisbon hotel we compared.");
    expect(await rpc<unknown[]>(app, owner, "actionOffers/list")).toEqual([]);
    // Let the taken run finish, so the next test's message starts its own run.
    await runUntilDone(taken.runId!);
  });

  it("offers save-as-skill after real work, and a routine's cards send one offer push", async () => {
    const sent = await rpc<{ runId: string }>(app, owner, "threads/send", {
      botId,
      text: "offer to save this as a skill",
    });
    await runUntilDone(sent.runId);
    const skill = (
      await rpc<Array<{ id: string; label: string; kind: string }>>(app, owner, "actionOffers/list")
    ).find((card) => card.kind === "save_skill");
    expect(skill?.label).toBe("Save as a skill");
    const source = await handles.prisma.actionOffer.findUniqueOrThrow({ where: { id: skill!.id } });
    expect(source.skillSource).toEqual(
      expect.arrayContaining([expect.stringContaining("schedule_list")]),
    );

    notifications.sent.length = 0;
    const routine = await rpc<{ id: string }>(app, owner, "routines/create", {
      botId,
      name: "Inbox check",
      prompt: 'offer the card "Answer 3 emails" to "Answer the three unread emails."',
      crons: ["0 9 * * *"],
    });
    const fired = await rpc<{ runId: string }>(app, owner, "routines/testRun", {
      routineId: routine.id,
    });
    await runUntilDone(fired.runId);
    expect(pushes("offer")).toEqual([
      expect.objectContaining({ body: "Answer 3 emails", messageId: expect.any(String) }),
    ]);
    expect(pushes("completion")).toEqual([]);

    // The same card again only extends the open one: no new message, no second push.
    const again = await rpc<{ runId: string }>(app, owner, "routines/testRun", {
      routineId: routine.id,
    });
    await runUntilDone(again.runId);
    expect(pushes("offer")).toHaveLength(1);
    expect(
      (await rpc<Array<{ label: string }>>(app, owner, "actionOffers/list")).filter(
        (card) => card.label === "Answer 3 emails",
      ),
    ).toHaveLength(1);
  });
});
