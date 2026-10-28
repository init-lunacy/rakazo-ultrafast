import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { ROW_SECURITY_MODELS } from "./row-security.js";

/**
 * Space-owned models without row-level security yet. Shrink this list as tables
 * gain policies; a new model with a `spaceId` gets a migration and a place in
 * ROW_SECURITY_MODELS instead of a line here.
 */
const UNPROTECTED_SPACE_MODELS = new Set([
  "ActionAutoReviewPreference",
  "AgentHome",
  "AiDataConsent",
  "BotDeletion",
  "BotSection",
  "BrowserProfile",
  "CapabilityInstall",
  "ChatGroup",
  "CloudAgent",
  "ExternalEffect",
  "MessagingLinkCode",
  "ModelCreditEntry",
  "NotificationPreference",
  "SpaceKey",
  "SpaceMember",
  "SpaceMemoryConfig",
  "SpaceModelPreference",
  "SpaceVoicePreference",
]);

describe("row-level security coverage", () => {
  // The client builds its data model without connecting.
  const { prisma } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
  const { models } = (
    prisma as unknown as {
      _runtimeDataModel: { models: Record<string, { fields: Array<{ name: string }> }> };
    }
  )._runtimeDataModel;
  const spaceModels = Object.keys(models).filter((name) =>
    models[name]!.fields.some((field) => field.name === "spaceId"),
  );

  it("protects every Space-owned model that is not explicitly exempt", () => {
    const unprotected = spaceModels.filter(
      (name) => !ROW_SECURITY_MODELS.has(name) && !UNPROTECTED_SPACE_MODELS.has(name),
    );
    expect(unprotected).toEqual([]);
  });

  it("exempts only Space-owned models that are still unprotected", () => {
    const stale = [...UNPROTECTED_SPACE_MODELS].filter(
      (name) => !spaceModels.includes(name) || ROW_SECURITY_MODELS.has(name),
    );
    expect(stale).toEqual([]);
  });
});
