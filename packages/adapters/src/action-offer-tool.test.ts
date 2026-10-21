import { DEFAULT_ACTION_OFFER_SETTINGS } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  replaceHeldActionOffers: vi.fn(async () => undefined),
  openActionOffersInChat: vi.fn(async () => [] as Array<{ id: string; label: string }>),
}));
vi.mock("@rakazo/db", () => store);

import type { ToolCallRecord } from "./action-offer-tool.js";
import {
  actionOffersAllowedForRun,
  offerActionsFromTool,
  recordToolCall,
  SAVE_SKILL_LABEL,
  skillSourceDigest,
} from "./action-offer-tool.js";

const now = new Date("2026-10-21T12:00:00.000Z");
const base = {
  run: { id: "run-1", spaceId: "space-1", userId: "user-1" },
  botId: "bot-1",
  threadId: "thread-1",
  settings: DEFAULT_ACTION_OFFER_SETTINGS,
  secrets: ["hunter2"],
  toolCalls: [] as ToolCallRecord[],
  stepCount: 0,
  ranSkill: false,
  startedBySaveSkillCard: false,
  now,
};
const call = (args: Record<string, unknown>, extra: Partial<typeof base> = {}) =>
  offerActionsFromTool({} as never, { ...base, ...extra, args });

beforeEach(() => {
  store.replaceHeldActionOffers.mockClear();
  store.openActionOffersInChat.mockResolvedValue([]);
});

describe("offer_actions", () => {
  it("holds valid cards with the default lifetime and redacts secrets", async () => {
    const result = await call({
      offers: [{ label: "Log in again", task: "Use hunter2 to log in." }],
    });
    expect(result).toMatchObject({ ok: true, willShow: ["Log in again"] });
    expect(store.replaceHeldActionOffers).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        runId: "run-1",
        offers: [
          expect.objectContaining({
            kind: "task",
            task: "Use [redacted] to log in.",
            expiresAt: new Date("2026-10-24T12:00:00.000Z"),
          }),
        ],
        close: [],
      }),
    );
  });

  it("refuses more cards than the setting allows, bad lengths and bad expiries", async () => {
    const offers = Array.from({ length: 4 }, (_, i) => ({ label: `L${i}`, task: "t" }));
    expect(await call({ offers })).toMatchObject({ error: expect.stringContaining("at most 3") });
    expect(await call({ offers: [{ label: "x".repeat(61), task: "t" }] })).toMatchObject({
      error: expect.stringContaining("60"),
    });
    expect(
      await call({ offers: [{ label: "L", task: "t", expiresAt: "2026-10-22T12:00:00" }] }),
    ).toMatchObject({ error: expect.stringContaining("offset") });
    expect(
      await call({ offers: [{ label: "L", task: "t", expiresAt: "2026-12-30T12:00:00Z" }] }),
    ).toMatchObject({ error: expect.stringContaining("30 days") });
    expect(store.replaceHeldActionOffers).not.toHaveBeenCalled();
  });

  it("refuses past the per-chat cap with the open list, and accepts once cards are closed", async () => {
    store.openActionOffersInChat.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Open ${i}` })),
    );
    const refused = await call({ offers: [{ label: "New", task: "t" }] });
    expect(refused).toMatchObject({
      error: expect.stringContaining("close"),
      openCards: expect.arrayContaining([{ id: "o0", label: "Open 0" }]),
    });
    expect(await call({ offers: [{ label: "New", task: "t" }], close: ["o0"] })).toMatchObject({
      ok: true,
    });
    expect(await call({ offers: [], close: ["nope"] })).toMatchObject({
      error: expect.stringContaining("o0"),
    });
  });

  it("offers save-as-skill only after enough steps, never after a skill run, never twice", async () => {
    const save = { offers: [{ kind: "save_skill" }] };
    expect(await call(save, { stepCount: 2 })).toMatchObject({
      error: expect.stringContaining("3"),
    });
    expect(await call(save, { stepCount: 5, ranSkill: true })).toMatchObject({
      error: expect.any(String),
    });
    expect(await call(save, { stepCount: 5, startedBySaveSkillCard: true })).toMatchObject({
      error: expect.any(String),
    });
    expect(
      await call({ offers: [{ kind: "save_skill" }, { kind: "save_skill" }] }, { stepCount: 5 }),
    ).toMatchObject({ error: expect.any(String) });
    const ok = await call(save, {
      stepCount: 5,
      toolCalls: [
        { name: "browser_navigate", args: { url: "https://example.test/?token=hunter2" } },
      ],
    });
    expect(ok).toMatchObject({ ok: true, willShow: [SAVE_SKILL_LABEL] });
    expect(store.replaceHeldActionOffers).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        offers: [
          expect.objectContaining({
            kind: "save_skill",
            label: SAVE_SKILL_LABEL,
            skillSource: ['browser_navigate {"url":"https://example.test/?token=[redacted]"}'],
          }),
        ],
      }),
    );
  });

  it("caps the skill source at 60 calls, 300 characters a value and 8,000 in all", () => {
    const calls = Array.from({ length: 80 }, (_, i) => ({
      name: "shell",
      args: { command: `${i} ${"x".repeat(500)}` },
    }));
    const digest = skillSourceDigest(calls, []);
    expect(digest.length).toBeLessThanOrEqual(60);
    expect(digest.join("").length).toBeLessThanOrEqual(8_000);
    expect(digest[0]!.length).toBeLessThan(330);
    expect(skillSourceDigest([{ name: "offer_actions", args: {} }], [])).toEqual([]);
  });

  it("is offered only to runs with a person in this chat to tap", () => {
    const allowed = (trigger: string, extra = {}) =>
      actionOffersAllowedForRun({ trigger, messagingChannelRun: false, ...extra });
    for (const trigger of ["user", "reaction", "routine", "webhook"])
      expect(allowed(trigger)).toBe(true);
    expect(allowed("follow_up", { followUpFromUser: true })).toBe(true);
    expect(allowed("follow_up", { followUpFromUser: false })).toBe(false);
    expect(allowed("user", { voiceCall: true })).toBe(false);
    expect(allowed("user", { messagingChannelRun: true })).toBe(false);
    for (const trigger of [
      "bot_message",
      "messaging",
      "created",
      "spawn",
      "tickets",
      "cloud_agent",
      "skill",
      "call_end",
      "resume",
    ])
      expect(allowed(trigger)).toBe(false);
  });
});

describe("offer_actions guards", () => {
  it("never keeps a secret in the skill source, however long or escaped", () => {
    const long = `L${"s3cret".repeat(500)}`;
    const awkward = 'line one\nsays "quoted" \\ end';
    const calls: ToolCallRecord[] = [];
    recordToolCall(calls, "shell", { command: `echo ${long}` }, [long, awkward]);
    recordToolCall(calls, "api", { body: { notes: [awkward] } }, [long, awkward]);
    const source = skillSourceDigest(calls, []).join("\n");
    expect(source).not.toContain(long.slice(0, 40));
    expect(source).not.toContain("line one");
    expect(source).not.toContain("quoted");
    expect(source).toContain("[redacted]");
  });

  it("refuses non-object offers, secret-bearing cards and over-length redactions", async () => {
    expect(await call({ offers: [null] })).toMatchObject({
      error: expect.stringContaining("object"),
    });
    // Redaction can leave text that is itself a secret; such a card is never stored.
    const leaky = await call(
      { offers: [{ label: "L", task: "x" }] },
      { secrets: ["x", "[redacted]"] },
    );
    expect(leaky).toMatchObject({ error: expect.stringContaining("credential") });
    expect(store.replaceHeldActionOffers).not.toHaveBeenCalled();
    const longSecret = "k".repeat(2_000);
    const long = await call(
      { offers: [{ label: "L", task: `use ${longSecret}` }] },
      { secrets: [longSecret] },
    );
    expect(long).toMatchObject({ ok: true });
  });

  it("always allows clearing or closing when the chat is over the cap", async () => {
    store.openActionOffersInChat.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Open ${i}` })),
    );
    expect(await call({ offers: [] })).toMatchObject({ ok: true });
    expect(await call({ offers: [], close: ["o0"] })).toMatchObject({ ok: true });
  });
});
