import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const ActionOfferStatusSchema = z.enum([
  "held",
  "open",
  "taken",
  "dismissed",
  "closed",
  "expired",
]);
export type ActionOfferStatus = z.infer<typeof ActionOfferStatusSchema>;

export const ActionOfferKindSchema = z.enum(["task", "save_skill"]);
export type ActionOfferKind = z.infer<typeof ActionOfferKindSchema>;

/** Hard ceilings in code; a person's settings tune within them. */
export const ACTION_OFFER_LIMITS = {
  labelMaxChars: 60,
  taskMaxChars: 2_000,
  lifetimeMaxDays: 30,
} as const;

const settingsShape = {
  enabled: z.boolean(),
  perReply: z.number().int().min(1).max(10),
  openPerChat: z.number().int().min(1).max(20),
  defaultLifetimeDays: z.number().int().min(1).max(ACTION_OFFER_LIMITS.lifetimeMaxDays),
  saveSkillMinSteps: z.number().int().min(1).max(50),
};

export const ActionOfferSettingsSchema = z.object(settingsShape);
export type ActionOfferSettings = z.infer<typeof ActionOfferSettingsSchema>;
export const ActionOfferSettingsPatchSchema = z.object(settingsShape).partial();

export const DEFAULT_ACTION_OFFER_SETTINGS: ActionOfferSettings = {
  enabled: true,
  perReply: 3,
  openPerChat: 6,
  defaultLifetimeDays: 3,
  saveSkillMinSteps: 3,
};

/** Stored settings with defaults for anything missing or out of range, key by key. */
export function parseActionOfferSettings(value: unknown): ActionOfferSettings {
  const stored =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const settings: Record<string, unknown> = { ...DEFAULT_ACTION_OFFER_SETTINGS };
  for (const [key, schema] of Object.entries(settingsShape)) {
    const parsed = schema.safeParse(stored[key]);
    if (parsed.success) settings[key] = parsed.data;
  }
  return settings as ActionOfferSettings;
}

/** One card as its message block shows it; the status mirrors the action_offers row. */
export const ActionOfferCardSchema = z.object({
  id: Id,
  kind: ActionOfferKindSchema,
  label: z.string(),
  task: z.string(),
  expiresAt: IsoDate,
  status: ActionOfferStatusSchema,
  /** The message a tap sent, so a taken card can link to it. */
  takenMessageId: Id.optional(),
});
export type ActionOfferCard = z.infer<typeof ActionOfferCardSchema>;

/** An open card in the collected list, with where it came from. */
export const ActionOfferListItemSchema = ActionOfferCardSchema.extend({
  botId: Id,
  groupId: Id.nullable(),
  threadId: Id,
  messageId: Id,
  createdAt: IsoDate,
});
export type ActionOfferListItem = z.infer<typeof ActionOfferListItemSchema>;
