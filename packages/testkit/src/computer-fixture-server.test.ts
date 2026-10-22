import { afterEach, describe, expect, it, vi } from "vitest";
import { executeChecked, startFixtureServer } from "./computer-fixture-server.js";
import { scriptedComputer } from "./scripted-sandbox.js";

const SERVER = {
  files: { "server.py": "print('hi')" },
  command: "setsid -f python3 server.py > server.log 2>&1 < /dev/null",
  readyUrl: "http://127.0.0.1:8800/health",
  logPath: "server.log",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("executeChecked", () => {
  it("returns the command's stdout", async () => {
    const { sandbox, computer, context } = await scriptedComputer(() => ({
      code: 0,
      stdout: "out",
    }));
    await expect(executeChecked(sandbox, computer, context, "echo out")).resolves.toBe("out");
  });

  it("fails with stderr when the command exits non-zero", async () => {
    const { sandbox, computer, context } = await scriptedComputer(() => ({
      code: 2,
      stderr: "no such file",
    }));
    await expect(executeChecked(sandbox, computer, context, "cat x")).rejects.toThrow(
      /no such file/,
    );
  });
});

describe("startFixtureServer", () => {
  it("writes the files, starts the server and returns once it answers", async () => {
    const { sandbox, computer, context, text } = await scriptedComputer(() => ({ code: 0 }));
    await startFixtureServer(sandbox, computer, context, SERVER);
    expect(await text("server.py")).toBe("print('hi')");
    expect(sandbox.commands[0]).toBe(SERVER.command);
    expect(sandbox.commands[1]).toContain(SERVER.readyUrl);
  });

  it("reports the server log when the server never answers", async () => {
    vi.useFakeTimers();
    const { sandbox, computer, context } = await scriptedComputer((command) =>
      command.startsWith("cat ")
        ? { code: 0, stdout: "Traceback: port in use" }
        : command.includes("urlopen")
          ? { code: 1, stderr: "connection refused" }
          : { code: 0 },
    );
    const started = startFixtureServer(sandbox, computer, context, SERVER);
    const failure = expect(started).rejects.toThrow(/did not become ready: Traceback: port in use/);
    await vi.runAllTimersAsync();
    await failure;
  });
});
