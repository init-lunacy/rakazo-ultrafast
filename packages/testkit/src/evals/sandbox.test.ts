import type { AdapterContext, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { destroyComputers, EvalSandboxProvider } from "./sandbox.js";

const context: AdapterContext = {
  operationId: "eval",
  traceId: "eval",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("honest offline eval shell results", () => {
  it("does not claim a shell-created file exists when it never executed the command", async () => {
    const sandbox = new EvalSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot", homePath: "/fixture" }, context);
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          "wrapper",
          "rakazo-background-launch",
          "computer",
          "run",
          "call",
          "mkdir -p results && printf 'Hello, workshop!' > results/greeting.txt",
        ],
      },
      context,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "exit", code: 127 });
    expect(events.some((event) => event.type === "stdout")).toBe(false);
    await expect(sandbox.readFile(computer, "results/greeting.txt", context)).rejects.toThrow();
    expect(sandbox.harnessIssues).toHaveLength(1);
    // The ordinary file tools still execute and produce independently readable artifacts.
    await sandbox.writeFile(
      computer,
      {
        path: "results/greeting.txt",
        content: new TextEncoder().encode("Hello, workshop!"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await sandbox.readFile(computer, "results/greeting.txt", context)),
    ).toBe("Hello, workshop!");
    await sandbox.destroy(computer, context);
  });
});

describe("destroyComputers", () => {
  const rows = [
    { homeKey: "team-a", kind: "docker", providerRef: "c1", spaceId: "s1", userId: "u1" },
    { homeKey: "team-b", kind: "docker", providerRef: "c2", spaceId: "s2", userId: "u2" },
  ];

  it("destroys every provisioned computer through the sandbox", async () => {
    const findMany = vi.fn(async () => rows);
    const destroy = vi.fn(async () => undefined);
    await destroyComputers({ computer: { findMany } } as never, { destroy } as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerRef: { not: null } } }),
    );
    expect(destroy.mock.calls.map(([ref]) => ref)).toEqual([
      { id: "c1", botId: "team-a", kind: "docker", providerRef: "c1" },
      { id: "c2", botId: "team-b", kind: "docker", providerRef: "c2" },
    ]);
  });

  it("tries every computer and reports the ones it could not destroy", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("supervisor down"))
      .mockResolvedValueOnce(undefined);
    await expect(
      destroyComputers({ computer: { findMany: async () => rows } } as never, { destroy } as never),
    ).rejects.toThrow(/Could not destroy every eval computer/);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
