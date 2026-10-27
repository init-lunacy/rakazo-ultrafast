import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const model: Model<"anthropic-messages"> = {
  provider: "anthropic",
  id: "unlock-model",
  name: "unlock-model",
  api: "anthropic-messages",
  baseUrl: "https://models.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

function tool(name: string): ConnectorTool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  } as ConnectorTool;
}

function reply(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function stream(message: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type !== "toolCall") continue;
    result.push({ type: "toolcall_start", contentIndex, partial: message });
    result.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
  }
  result.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  result.end(message);
  return result;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(
    `${model.provider}/${model.id}`,
    model as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
});

it("offers tools a call unlocked from the next turn, with their guidance", async () => {
  const contexts: Context[] = [];
  const calls = ["create_widget", "arrange_widgets"];
  providerState.stream.mockImplementation((_model: unknown, context: Context) => {
    contexts.push(structuredClone(context));
    const name = calls[contexts.length - 1];
    return stream(
      reply(
        name
          ? [{ type: "toolCall", id: `call-${contexts.length}`, name, arguments: {} }]
          : [{ type: "text", text: "Done." }],
      ),
    );
  });
  let unlocked = false;
  const executeTool = vi.fn(async (name: string) => {
    if (name === "create_widget") unlocked = true;
    return { ok: true };
  });
  const request = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Make a widget and arrange it",
    instructions: "Use tools when useful.",
    history: [],
    tools: [tool("create_widget")],
    model: { provider: model.provider, id: model.id, apiKey: "fake-key" },
    executeTool,
    unlockedTools: () =>
      unlocked
        ? { tools: [tool("create_widget"), tool("arrange_widgets")], instructions: "Widget rules." }
        : undefined,
  } as unknown as AgentRunRequest;

  for await (const _event of new PiAgentRuntime().run(request, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    // Drain the run.
  }

  // The provider learns about tools from the declarations its system messages carry.
  const toolNames = (context: Context) =>
    context.messages.flatMap((message) =>
      message.role === "system" ? (message.toolsAdded ?? []).map((item) => item.name) : [],
    );
  expect(toolNames(contexts[0]!)).toEqual(["create_widget"]);
  expect(toolNames(contexts[1]!)).toEqual(["create_widget", "arrange_widgets"]);
  expect(JSON.stringify(contexts[1]!.messages)).toContain("Widget rules.");
  // Guidance is added once, not again on later turns.
  expect(JSON.stringify(contexts[2]!.messages).split("Widget rules.")).toHaveLength(2);
  expect(executeTool.mock.calls.map(([name]) => name)).toEqual([
    "create_widget",
    "arrange_widgets",
  ]);
});
