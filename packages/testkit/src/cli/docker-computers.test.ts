import { describe, expect, it } from "vitest";
import { dockerComputerEnv } from "./docker-computers.js";

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
      BROWSER_PROVIDER: "computer",
    });
  });
});
