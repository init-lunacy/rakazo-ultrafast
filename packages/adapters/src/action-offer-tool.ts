import type { ActionOfferKind, ActionOfferSettings } from "@rakazo/contracts";
import { ACTION_OFFER_LIMITS, IsoDate } from "@rakazo/contracts";
import { containsSecret, redactSecrets } from "@rakazo/core";
import type { HeldActionOfferInput, PrismaClient } from "@rakazo/db";
import { openActionOffersInChat, replaceHeldActionOffers } from "@rakazo/db";

export const SAVE_SKILL_LABEL = "Save as a skill";
export const SAVE_SKILL_TASK =
  "Save what you did in the message I'm replying to as a skill with skill_create, so any bot can repeat it. Describe the steps, the inputs it needs, and how to tell it worked.";

const DAY_MS = 24 * 60 * 60 * 1000;
const SKILL_SOURCE = { calls: 60, valueChars: 300, totalChars: 8_000 } as const;
const RECORDED = { calls: 200, valueChars: 2_000 } as const;
const CONVERSATIONAL_OFFER_TRIGGERS = new Set(["user", "reaction", "routine", "webhook"]);

export type ToolCallRecord = { name: string; args: Record<string, unknown> };

/** Only runs with a person in this chat to tap a card get the tool. */
export function actionOffersAllowedForRun(options: {
  trigger: string;
  voiceCall?: boolean;
  messagingChannelRun: boolean;
  followUpFromUser?: boolean;
}): boolean {
  if (options.voiceCall || options.messagingChannelRun) return false;
  if (options.trigger === "follow_up") return Boolean(options.followUpFromUser);
  return CONVERSATIONAL_OFFER_TRIGGERS.has(options.trigger);
}

const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

/** Redacts every string leaf, so a secret is caught before JSON escaping or cutting can disguise it. */
function redactLeaves(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLeaves(item, secrets)]),
    );
  }
  return value;
}

/** Keeps a run's calls for a save-skill offer, bounded so a long run holds little memory. */
export function recordToolCall(
  calls: ToolCallRecord[],
  name: string,
  args: unknown,
  secrets: string[],
): void {
  if (calls.length >= RECORDED.calls) return;
  const entries =
    args && typeof args === "object" ? Object.entries(args as Record<string, unknown>) : [];
  calls.push({
    name,
    args: Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        valueText(redactLeaves(value, secrets)).slice(0, RECORDED.valueChars),
      ]),
    ),
  });
}

/** What the run did, so a later save-skill run can write the skill from it. */
export function skillSourceDigest(calls: readonly ToolCallRecord[], secrets: string[]): string[] {
  const lines: string[] = [];
  let total = 0;
  for (const call of calls.filter((entry) => entry.name !== "offer_actions")) {
    if (lines.length === SKILL_SOURCE.calls) break;
    // Redact the whole value first, so shortening it can never leave part of a secret.
    const args = Object.fromEntries(
      Object.entries(call.args ?? {}).map(([key, value]) => [
        key,
        redactSecrets(valueText(value), secrets).slice(0, SKILL_SOURCE.valueChars),
      ]),
    );
    const line = `${call.name} ${JSON.stringify(args)}`;
    if (total + line.length > SKILL_SOURCE.totalChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines;
}

type OfferArg = { kind?: unknown; label?: unknown; task?: unknown; expiresAt?: unknown };

export async function offerActionsFromTool(
  prisma: PrismaClient,
  input: {
    args: Record<string, unknown>;
    run: { id: string; spaceId: string; userId: string };
    botId: string;
    threadId: string;
    settings: ActionOfferSettings;
    secrets: string[];
    toolCalls: readonly ToolCallRecord[];
    stepCount: number;
    ranSkill: boolean;
    startedBySaveSkillCard: boolean;
    now: Date;
  },
): Promise<
  | { ok: true; willShow: string[]; openCards: Array<{ id: string; label: string }> }
  | { error: string; openCards?: Array<{ id: string; label: string }> }
> {
  const offers = Array.isArray(input.args.offers) ? (input.args.offers as OfferArg[]) : null;
  const close = Array.isArray(input.args.close) ? [...new Set(input.args.close.map(String))] : [];
  if (!offers) return { error: "offers must be a list; send [] to only close cards." };
  if (offers.some((offer) => !offer || typeof offer !== "object" || Array.isArray(offer))) {
    return { error: "Each offer must be an object with a label and a task." };
  }
  if (offers.length > input.settings.perReply) {
    return {
      error: `Offer at most ${input.settings.perReply} cards in one reply; keep the most useful.`,
    };
  }
  const open = (
    await openActionOffersInChat(prisma, {
      threadId: input.threadId,
      botId: input.botId,
      now: input.now,
    })
  ).map(({ id, label }) => ({ id, label }));
  const unknown = close.filter((id) => !open.some((card) => card.id === id));
  if (unknown.length > 0) {
    return {
      error: `close names cards that are not your open cards here. Open: ${open.map((card) => card.id).join(", ") || "none"}.`,
      openCards: open,
    };
  }
  // Clearing this run's offers or only closing cards is always allowed.
  if (
    offers.length > 0 &&
    open.length - close.length + offers.length > input.settings.openPerChat
  ) {
    return {
      error: `This chat would have more than ${input.settings.openPerChat} open cards. Name the ones this offer supersedes in close, or offer fewer.`,
      openCards: open,
    };
  }

  const held: HeldActionOfferInput[] = [];
  for (const offer of offers) {
    const kind: ActionOfferKind = offer.kind === "save_skill" ? "save_skill" : "task";
    const expiresAt = parseExpiry(offer.expiresAt, input.settings.defaultLifetimeDays, input.now);
    if ("error" in expiresAt) return { error: expiresAt.error };
    if (kind === "save_skill") {
      const refusal = saveSkillRefusal(input, held);
      if (refusal) return { error: refusal };
      held.push({
        kind,
        label: SAVE_SKILL_LABEL,
        task: SAVE_SKILL_TASK,
        expiresAt: expiresAt.date,
        skillSource: skillSourceDigest(input.toolCalls, input.secrets),
      });
      continue;
    }
    const label = redactSecrets(
      typeof offer.label === "string" ? offer.label.trim() : "",
      input.secrets,
    );
    const task = redactSecrets(
      typeof offer.task === "string" ? offer.task.trim() : "",
      input.secrets,
    );
    if (containsSecret(label, input.secrets) || containsSecret(task, input.secrets)) {
      return { error: "A card still contains a credential. Never put credentials in cards." };
    }
    if (!label || label.length > ACTION_OFFER_LIMITS.labelMaxChars) {
      return { error: `Each label needs 1 to ${ACTION_OFFER_LIMITS.labelMaxChars} characters.` };
    }
    if (!task || task.length > ACTION_OFFER_LIMITS.taskMaxChars) {
      return {
        error: `Each task needs 1 to ${ACTION_OFFER_LIMITS.taskMaxChars} characters; write it to make sense on its own later.`,
      };
    }
    held.push({
      kind,
      label,
      task,
      expiresAt: expiresAt.date,
    });
  }

  await replaceHeldActionOffers(prisma, {
    spaceId: input.run.spaceId,
    userId: input.run.userId,
    threadId: input.threadId,
    botId: input.botId,
    runId: input.run.id,
    offers: held,
    close,
  });
  return { ok: true, willShow: held.map((offer) => offer.label), openCards: open };
}

function parseExpiry(
  value: unknown,
  defaultDays: number,
  now: Date,
): { date: Date } | { error: string } {
  if (value === undefined || value === null || value === "") {
    return { date: new Date(now.getTime() + defaultDays * DAY_MS) };
  }
  if (!IsoDate.safeParse(value).success) {
    return {
      error: "expiresAt must be an ISO 8601 time with an offset, such as 2026-10-24T17:00:00Z.",
    };
  }
  const date = new Date(value as string);
  if (date.getTime() <= now.getTime()) return { error: "expiresAt must be in the future." };
  if (date.getTime() - now.getTime() > ACTION_OFFER_LIMITS.lifetimeMaxDays * DAY_MS) {
    return { error: `expiresAt must be within ${ACTION_OFFER_LIMITS.lifetimeMaxDays} days.` };
  }
  return { date };
}

function saveSkillRefusal(
  input: {
    stepCount: number;
    ranSkill: boolean;
    startedBySaveSkillCard: boolean;
    settings: ActionOfferSettings;
  },
  held: HeldActionOfferInput[],
): string | null {
  if (held.some((offer) => offer.kind === "save_skill")) return "Offer save_skill at most once.";
  if (input.startedBySaveSkillCard) return "This run is already saving a skill.";
  if (input.ranSkill) return "This run followed a saved skill; there is nothing new to save.";
  if (input.stepCount < input.settings.saveSkillMinSteps) {
    return `Offer save_skill after at least ${input.settings.saveSkillMinSteps} steps of real work.`;
  }
  return null;
}
