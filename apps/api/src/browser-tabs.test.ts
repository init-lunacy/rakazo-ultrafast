import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { latestBrowserTabs, showBrowserTab } from "./browser-tabs.js";

const tabs = {
  tabs: [
    { target: "T1", title: "A", url: "https://a.test/", owner: "Ada" },
    { target: "T2", title: "B", url: "https://b.test/", owner: "Hotels" },
  ],
  front: "T1",
  pinned: null,
};

function prismaWith(payload: unknown) {
  return {
    run: { findFirst: vi.fn().mockResolvedValue({ id: "run-1", threadId: "group-thread" }) },
    event: { findFirst: vi.fn().mockResolvedValue(payload === undefined ? null : { payload }) },
  } as unknown as PrismaClient;
}

const computer: ComputerRef = { id: "c", botId: "home", kind: "docker", providerRef: "c" };
const context = {
  operationId: "o",
  traceId: "o",
  spaceId: "s",
  userId: "u",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("browser tabs for the computer view", () => {
  it("reads the latest run's tab list by bot, and ignores a malformed one", async () => {
    const prisma = prismaWith(tabs);
    expect(await latestBrowserTabs(prisma, "bot-1")).toEqual(tabs);
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: "bot-1" } }),
    );
    expect(await latestBrowserTabs(prismaWith({ tabs: "nope" }), "bot-1")).toBeUndefined();
    expect(await latestBrowserTabs(prismaWith(undefined), "bot-1")).toBeUndefined();
  });

  it("pins a tab on the computer and records it in the latest run's own thread", async () => {
    const pageBrowser = vi.fn().mockResolvedValue({ ok: true, front: "T2", pinned: "T2" });
    const append = vi.fn().mockResolvedValue({});
    await showBrowserTab(
      { prisma: prismaWith(tabs), sandbox: { pageBrowser } as never, events: { append } as never },
      { spaceId: "s", botId: "bot-1", computer, target: "T2" },
      context,
    );
    expect(pageBrowser).toHaveBeenCalledWith(
      computer,
      { command: "activate", target: "T2", pin: true },
      context,
    );
    expect(append).toHaveBeenCalledWith({
      spaceId: "s",
      threadId: "group-thread",
      botId: "bot-1",
      type: "computer.browser_tabs",
      runId: "run-1",
      allowCancelledRun: true,
      payload: { ...tabs, front: "T2", pinned: "T2" },
    });
  });

  it("unpins without moving the view, and does nothing on a computer without a page browser", async () => {
    const pageBrowser = vi.fn().mockResolvedValue({ ok: true, front: null, pinned: null });
    const append = vi.fn().mockResolvedValue({});
    await showBrowserTab(
      {
        prisma: prismaWith({ ...tabs, pinned: "T2" }),
        sandbox: { pageBrowser } as never,
        events: { append } as never,
      },
      { spaceId: "s", botId: "bot-1", computer, target: null },
      context,
    );
    expect(pageBrowser).toHaveBeenCalledWith(
      computer,
      { command: "activate", target: null, pin: false },
      context,
    );
    expect(append.mock.calls[0]?.[0].payload).toMatchObject({ front: "T1", pinned: null });

    const none = vi.fn();
    await showBrowserTab(
      { prisma: prismaWith(tabs), sandbox: {} as never, events: { append: none } as never },
      { spaceId: "s", botId: "bot-1", computer, target: "T2" },
      context,
    );
    expect(none).not.toHaveBeenCalled();
  });
});
