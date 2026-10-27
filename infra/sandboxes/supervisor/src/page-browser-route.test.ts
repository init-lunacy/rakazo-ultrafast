import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn(), stdin: [] as string[] }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";
import { browserRunningCommand, SCREEN_REUSE_MS } from "./supervisor-logic.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.stdin.length = 0;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    // Docker's hijacked exec stream is duplex: stdin is written, output is read.
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
              ? JSON.stringify({
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                })
              : "",
          ),
        ]),
        writable: new Writable({
          write(chunk, _encoding, callback) {
            mock.stdin.push(String(chunk));
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});

async function snapshot(id: string, screen: string, lease: string, home = "home") {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": home,
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screen,
      "x-rakazo-screen-lease-id": lease,
    },
    body: JSON.stringify({ command: "snapshot" }),
  });
}

it("resolves the owned display and refuses an older fence before running the helper", async () => {
  expect(await (await snapshot("computer-lease", "first", "run:2")).json()).toMatchObject({
    ok: true,
  });
  expect(await (await snapshot("computer-lease", "second", "other:2")).json()).toMatchObject({
    ok: true,
  });
  expect(mock.exec.mock.calls.at(-1)?.[0]).toMatchObject({
    Env: [
      "DISPLAY=:2",
      "RAKAZO_CDP_PORT=9223",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "RAKAZO_BROWSER_WATCH_STDIN=1",
      "RAKAZO_BROWSER_ARGS_STDIN=1",
    ],
  });
  mock.exec.mockClear();
  expect(await (await snapshot("computer-lease", "first", "run:1")).json()).toMatchObject({
    ok: false,
  });
  expect(mock.exec).not.toHaveBeenCalled();
});

async function browser(body: unknown) {
  return supervisorApp.request("/computers/computer-capture/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify(body),
  });
}

it("forwards an extended snapshot to the helper", async () => {
  expect(await (await browser({ command: "snapshot", extended: true })).json()).toMatchObject({
    ok: true,
  });
  expect(mock.stdin.join("")).toBe(`${JSON.stringify({ command: "snapshot", extended: true })}\n`);
});

it("forwards a whole-number text offset and refuses any other", async () => {
  expect((await browser({ command: "snapshot", textOffset: 6000 })).ok).toBe(true);
  expect(mock.stdin.join("")).toBe(
    `${JSON.stringify({ command: "snapshot", textOffset: 6000 })}\n`,
  );
  mock.stdin.length = 0;
  for (const textOffset of [-1, 1.5, "6000"]) {
    expect((await browser({ command: "snapshot", textOffset })).ok).toBe(false);
  }
  expect(mock.stdin).toEqual([]);
});

// A viewport PNG is routinely larger than any snapshot, so only the capture
// gets the larger output cap.
it("returns a page capture larger than the snapshot output cap", async () => {
  const data = "A".repeat(700 * 1024);
  mock.exec.mockImplementation(async () => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([Buffer.from(JSON.stringify({ ok: true, data, scale: 1 }))]),
        writable: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
  expect(await (await browser({ command: "screenshot" })).json()).toEqual({
    ok: true,
    data,
    scale: 1,
  });
});

// Run cleanup after Stop: launching the browser would restore every tab Stop shut down.
it.each([
  [false, 1],
  [true, 0],
])("with launch skipped, runs the helper only if the browser runs: %s", async (runs, code) => {
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) =>
    options.Cmd[2] === browserRunningCommand("home")
      ? { ...(await defaultExec(options)), inspect: async () => ({ ExitCode: code }) }
      : defaultExec(options),
  );
  const response = await supervisorApp.request(`/computers/computer-skip-${runs}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-skip-browser-launch": "1",
    },
    body: JSON.stringify({ command: "tabs" }),
  });
  const commands = mock.exec.mock.calls.map(([options]) => options.Cmd.join(" "));
  expect(commands[0]).toBe(`bash -c ${browserRunningCommand("home")}`);
  if (runs) {
    expect(await response.json()).toMatchObject({ ok: true });
    expect(commands.at(-1)).toContain("/usr/local/bin/rakazo-page-browser");
  } else {
    expect(await response.json()).toMatchObject({ ok: false, fallback: "computer_act" });
    expect(commands).toHaveLength(1);
  }
});

it("rejects another computer identity before any command executes", async () => {
  expect(
    await (await snapshot("computer-identity", "first", "run:1", "foreign-home")).json(),
  ).toMatchObject({ ok: false });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["http", "https"])(
  "rejects %s URL credentials before executing any command",
  async (scheme) => {
    const response = await supervisorApp.request("/computers/computer-credentials/browser", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "navigate",
        url: `${scheme}://example:fake-password@example.test`,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it("closes helper stdin when the request is cancelled", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    expect(options.AttachStdin).toBe(true);
    return {
      start: async (options: { stdin: boolean }) => {
        expect(options.stdin).toBe(true);
        started();
        return stream;
      },
      inspect: async () => ({ ExitCode: 130 }),
    };
  });
  const response = supervisorApp.request("/computers/computer-cancel/browser", {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "test-ref" }] }),
  });
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
  expect(stream.destroyed).toBe(true);
});

it("sends a saved-login fill only over stdin, never in the helper's arguments", async () => {
  const actions = [
    { kind: "fill", ref: "e1", text: "fake-password-1", origin: "https://login.example.test" },
  ];
  const response = await supervisorApp.request("/computers/computer-login/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:9",
    },
    body: JSON.stringify({ command: "act", actions }),
  });
  expect(await response.json()).toMatchObject({ ok: true });
  const helperCall = mock.exec.mock.calls.find(([options]) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
  )!;
  expect(JSON.stringify(helperCall[0].Cmd)).not.toContain("fake-password-1");
  expect(helperCall[0].Env).toContain("RAKAZO_BROWSER_ARGS_STDIN=1");
  expect(mock.stdin.join("")).toBe(`${JSON.stringify({ command: "act", actions })}\n`);
});

it("forwards tab commands and an addressed snapshot to the helper", async () => {
  for (const body of [
    { command: "snapshot", target: "T1" },
    { command: "tabs" },
    { command: "open", url: "https://example.test/" },
    { command: "activate", target: "T1", pin: true },
    { command: "activate", target: null, pin: false },
    { command: "close", target: "T1" },
  ]) {
    mock.stdin.length = 0;
    expect((await browser(body)).status).toBe(200);
    expect(mock.stdin.join("")).toBe(`${JSON.stringify(body)}\n`);
  }
});

it("refuses an open with credentials in the URL before the helper runs", async () => {
  mock.exec.mockClear();
  const response = await browser({ command: "open", url: "https://user:fake@example.test/" });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mock.exec).not.toHaveBeenCalled();
});

it("passes an older helper's unknown-command answer through, so callers know it has no tabs", async () => {
  const answer = { ok: false, error: "unknown command: tabs", fallback: "computer_act" };
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    const helper = options.Cmd.includes("/usr/local/bin/rakazo-page-browser");
    return {
      start: async () =>
        Duplex.from({
          readable: Readable.from([Buffer.from(helper ? JSON.stringify(answer) : "")]),
          writable: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        }),
      inspect: async () => ({ ExitCode: helper ? 2 : 0 }),
    };
  });
  const response = await browser({ command: "tabs" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: false, error: "unknown command: tabs" });
});

it.each([
  [{ command: "snapshot" }, "Retry once"],
  [{ command: "act", actions: [{ kind: "click", ref: "e1" }] }, "Inspect the screen"],
])("reports a helper that exceeds its deadline as a timeout: %j", async (body, advice) => {
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    if (options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) {
      return {
        start: async () =>
          Duplex.from({ readable: Readable.from([]), writable: new PassThrough() }),
        inspect: async () => ({ ExitCode: 124 }),
      };
    }
    if (options.Cmd[0] === "sh") {
      return {
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 1 }),
      };
    }
    return defaultExec(options);
  });
  const response = await supervisorApp.request("/computers/computer-timeout/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:1",
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { error: string; uncertain: boolean };
  expect(result).toMatchObject({
    ok: false,
    fallback: "computer_act",
    error: expect.stringContaining("timed out"),
  });
  expect(result.error).toContain(advice);
  expect(result.uncertain).toBe(body.command === "act");
});

async function uploadRequest(roots?: unknown) {
  return supervisorApp.request("/computers/computer-upload/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      command: "act",
      actions: [{ kind: "upload", ref: "e1", paths: ["bots/b1/file.txt"], roots }],
    }),
  });
}

it.each([undefined, ["bots/b1", "shared"]])("forwards trusted upload roots: %j", async (roots) => {
  expect(await (await uploadRequest(roots)).json()).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join("")).actions[0]).toEqual({
    kind: "upload",
    ref: "e1",
    paths: ["bots/b1/file.txt"],
    ...(roots ? { roots } : {}),
  });
});

it.each([["a", "b", "c"], [""], ["x".repeat(1025)]])(
  "rejects invalid upload roots before running commands: %j",
  async (...roots) => {
    expect((await uploadRequest(roots)).status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it.each([undefined, "5"])("forwards the upload size override only when set: %j", async (limit) => {
  const original = process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
  try {
    if (limit === undefined) delete process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
    else process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES = limit;
    expect(await (await uploadRequest()).json()).toMatchObject({ ok: true });
    const helper = mock.exec.mock.calls.find(([options]) =>
      options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
    )!;
    const overrides = helper[0].Env.filter((value: string) =>
      value.startsWith("RAKAZO_BROWSER_UPLOAD_MAX_BYTES="),
    );
    expect(overrides).toEqual(
      limit === undefined ? [] : [`RAKAZO_BROWSER_UPLOAD_MAX_BYTES=${limit}`],
    );
  } finally {
    if (original === undefined) delete process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
    else process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES = original;
  }
});

describe("screen setup reuse", () => {
  const bootedAt = "2026-10-27T00:00:00.000Z";
  const helper = (options: { Cmd: string[] }) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser");
  const commands = () =>
    mock.exec.mock.calls.map(([options]) => (helper(options) ? "helper" : "setup"));

  beforeEach(() => {
    mock.inspect.mockResolvedValue({
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
      },
      State: { StartedAt: bootedAt },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs only the page helper for a screen set up moments ago", async () => {
    await snapshot("computer-reuse", "reuse", "run:1");
    mock.exec.mockClear();
    expect(await (await snapshot("computer-reuse", "reuse", "run:1")).json()).toMatchObject({
      ok: true,
    });
    expect(commands()).toEqual(["helper"]);
  });

  it("sets the screen up again once its last setup is 30 seconds old", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await snapshot("computer-stale", "stale", "run:1");
    clock.mockReturnValue(now + SCREEN_REUSE_MS);
    mock.exec.mockClear();
    await snapshot("computer-stale", "stale", "run:1");
    expect(commands().at(0)).toBe("setup");
    expect(commands().at(-1)).toBe("helper");
  });

  it("still refuses an older lease on a reused screen", async () => {
    await snapshot("computer-reuse-fence", "fenced", "run:2");
    mock.exec.mockClear();
    expect(await (await snapshot("computer-reuse-fence", "fenced", "run:1")).json()).toMatchObject({
      ok: false,
    });
    expect(mock.exec).not.toHaveBeenCalled();
  });

  it("sets up a reused screen whose browser has exited, then retries the helper once", async () => {
    await snapshot("computer-exited", "exited", "run:1");
    const defaultExec = mock.exec.getMockImplementation()!;
    let helperCalls = 0;
    mock.exec.mockClear();
    mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
      if (!helper(options) || helperCalls++ > 0) return defaultExec(options);
      return {
        start: async () =>
          Duplex.from({
            readable: Readable.from([
              Buffer.from(
                JSON.stringify({
                  ok: false,
                  error: "CDP not ready on port 9222: unreachable",
                  fallback: "computer_act",
                  uncertain: false,
                }),
              ),
            ]),
            writable: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
          }),
        inspect: async () => ({ ExitCode: 0 }),
      };
    });
    expect(await (await snapshot("computer-exited", "exited", "run:1")).json()).toMatchObject({
      ok: true,
    });
    expect(commands()).toEqual(["helper", "setup", "helper"]);
  });
});
