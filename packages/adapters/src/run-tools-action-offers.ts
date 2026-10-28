import { offerActionsFromTool } from "./action-offer-tool.js";
import { isSubagentToolExecution } from "./run-effects.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** Action cards the main agent offers the user for a next step. */
export const actionOfferTools: ToolHandlers = {
  async offer_actions(ctx, call) {
    const { deps, run, runId, bot, thread } = ctx;
    if (isSubagentToolExecution(call.executionId)) {
      return call.finish({ error: "Only the main agent offers cards; tell it what to offer." });
    }
    // Event payloads are sealed at rest, so the tool name is read after the client opens them.
    const toolEvents = await deps.prisma.event.findMany({
      where: { runId, type: "agent.tool.called" },
      select: { payload: true },
    });
    const stepCount = toolEvents.filter(
      (event) => (event.payload as { name?: unknown } | null)?.name !== "offer_actions",
    ).length;
    const { toolCalls } = ctx.state;
    return call.finish(
      await offerActionsFromTool(deps.prisma, {
        args: call.args,
        run: { id: runId, spaceId: run.spaceId, userId: run.userId },
        botId: bot.id,
        threadId: thread.id,
        settings: ctx.actionOffers.settings,
        secrets: ctx.secrets,
        toolCalls,
        stepCount,
        ranSkill:
          ctx.actionOffers.ranSkill() || toolCalls.some((entry) => entry.name === "skill_read"),
        startedBySaveSkillCard: Boolean(ctx.actionOffers.saveSkillSource),
        now: new Date(),
      }),
    );
  },
};
