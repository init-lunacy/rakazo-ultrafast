import { describe, expect, it, vi } from "vitest";
import { destroyComputers, dockerComputerEnv } from "./docker-computers.js";

describe("dockerComputerEnv", () => {
  it("pins every setting a real computer depends on", () => {
    expect(dockerComputerEnv("/data", "rakazo/computer:local")).toEqual({
      DATA_DIR: "/data",
      RAKAZO_COMPUTER_IMAGE: "rakazo/computer:local",
      SANDBOX_PROVIDER: "docker",
      SANDBOX_SCREEN_NETWORK: "published",
      SANDBOX_SCREEN_HOST: "127.0.0.1",
      SANDBOX_CONTROL_VIA_LOOPBACK: "true",
      SANDBOX_IDLE_MS: "0",
      SANDBOX_COMPUTER_EGRESS: "open",
    });
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
