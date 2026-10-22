# Browsing Benchmark (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `browsing` suite in the existing live eval runner. It runs four browsing tasks through the real product against a real Docker bot computer and synthetic local sites, and reports success, task time, steps and cost.

**Architecture:**
- **Reuse:** the eval CLI (`packages/testkit/src/cli/evals.ts`) and runner (`packages/testkit/src/evals/runner.ts`) stay as they are, gaining a data-driven suite description and one optional computer-fixture hook.
- **Extract:** two shared helpers, Docker computer startup and the in-computer fixture server, are extracted from code that already exists twice.
- **Sites:** one Python standard-library server renders three synthetic sites from one `sites.json`. Graders compute their answers from the same file.

**Tech Stack:** TypeScript (ESM, vitest, tsx), Python 3 standard library, Docker, Prisma, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-21-browsing-benchmark-design.md`

## Global Constraints

- **Public repo:** no secrets, personal data, local paths, usernames or hostnames in code, commits or PRs. No attribution lines.
- **Imports:** top-level `import type` only, never inline `type` imports. Dynamic `import()` only for necessary deferred loading. This plan uses it in exactly two places, each commented with the reason.
- **Tests:** deterministic and offline. Only the final live check uses a model or Docker.
- **Reuse:**
  - existing symbols and names: `EvalCase`, `Evidence`, `TrialOptions`, `EvalApp`, `TrialResult`, `summarize`, `disabledBuiltinTools`, `toComputerRef`;
  - existing fixtures: `contacts` fixture, `pricing-openrouter-*.json` shape, `evals.test.ts`, `measurement.test.ts`, `cli.test.ts`.
- **Light imports for `--list`:** `--list` must not import `@rakazo/db` or `@rakazo/adapters` (guarded by `packages/testkit/src/evals/cli.test.ts`). Anything `evals.ts` imports statically must stay free of both.
- **Existing suites unchanged:** product, history and silence keep today's controls (180000 ms, 30 tool calls), fixtures text and limitations text exactly.
- **Suite names:** `product`, `history`, `silence`, `browsing`.
- **Browsing settings:**
  - tool limit 60, time limit 300000 ms;
  - disabled tools `shell`, `web_fetch`, `web_search`;
  - `connections: []`.
- **Site placement:** port `8800` inside the computer. Data and log live in `/tmp/rakazo-sites`, outside the bot home.
- **Fixture version:** `browsing-v1`, from `sites.json` `version`.
- **Lint and format:** Biome (`pnpm exec biome check <files>`). Python must run on the image's `python3` (3.11+) with the standard library only. CI has no Python linter, so `python3 -m py_compile` is the check.
- **Typecheck:** `pnpm --filter @rakazo/testkit check`.
- **No provider-specific settings:** no new provider- or model-specific environment variables. The model comes only through the existing generic flags (`--provider`, `--model`, `--api-key-env`, `--connection`).
- **Test fixtures:** extend existing ones. Fake sandboxes extend `FakeSandboxProvider` from `@rakazo/adapters`, the way `EvalSandboxProvider` does. Prisma shapes reuse `ReturnType<typeof createDb>["prisma"]`, as `EvalApp` does.

## Review Focus

1. **The bot's own tools reaching the site data.** `read_file` and `write_file` must not reach `/tmp/rakazo-sites`. The install must leave nothing of the site in the home. Pinned by Task 6's "moves the site out of the home" test.
2. **A double or partial checkout.** Graders must fail two confirms. The server must refuse a confirm with missing fields and issue no order number for it. Pinned by Task 3's "refuses an incomplete order" test and Task 5's "fails a double submit" test.
3. **A task with more than one defensible answer.** This includes ties on price and decoys on the wrong page. Pinned by Task 5's "one answer per task" tests, which run against the rendered pages.
4. **Leaked computers when a trial fails partway.** `stop` must destroy computers even when the trial threw, and destroying an already-destroyed computer must be harmless (the adapter treats 404 as done).
   - Task 2's `destroyComputers` tests pin trying every computer even after one fails.
   - The final live check pins that no container remains.
   - The `stop` wiring in `cli/evals.ts` has no unit test; the runner's existing `finally` always calls `stop`.
5. **A broken site or computer read counted against the model.** If the computer, the server or the request log can't be reached, the trial is a harness failure, not an agent failure. Pinned in Task 4: both fixture calls are wrapped as `EvalFailure("harness", ...)`.
6. **Existing suites drifting.** Changes to `evals.ts`, the controls defaults and the report text must not alter product, history or silence. Pinned by Task 7's suite tests, which compare against today's literal values.

---

### Task 1: Shared in-computer fixture server

Extract the write → start → poll-until-ready code that `installContactsFixture` carries, so the browsing sites reuse it.

**Files:**
- Create: `packages/testkit/src/computer-fixture-server.ts`
- Create: `packages/testkit/src/scripted-sandbox.ts` (test helper extending `FakeSandboxProvider`, reused by Task 6)
- Test: `packages/testkit/src/computer-fixture-server.test.ts`
- Modify: `packages/testkit/src/computer-replay-fixture.ts` (around lines 116-201: `installContactsFixture` body and the private `executeChecked`)

**Interfaces:**
- Produces:
  - `executeChecked(sandbox: SandboxProvider, computer: ComputerRef, context: AdapterContext, command: string): Promise<string>` returns stdout and throws on a non-zero exit with stderr in the message.
  - `type FixtureServer = { files: Record<string, string>; command: string; readyUrl: string; logPath: string }`
  - `startFixtureServer(sandbox, computer, context, server: FixtureServer): Promise<void>`
  - `class ScriptedSandboxProvider extends FakeSandboxProvider`, with `constructor(answer: (command: string) => { code: number; stdout?: string; stderr?: string })` and `readonly commands: string[]`. Files written through it are real fake-sandbox files, read back with the base `readFile`.
  - `scriptedComputer(answer)` returns `Promise<{ sandbox: ScriptedSandboxProvider; computer: ComputerRef; context: AdapterContext; text(path: string): Promise<string> }>`.

- [ ] **Step 1: Write the test helper and the failing tests**

`packages/testkit/src/scripted-sandbox.ts`. It follows the existing `EvalSandboxProvider`, which also extends the shared fake and overrides only `execute`:

```ts
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";

type Answer = (command: string) => { code: number; stdout?: string; stderr?: string };

/** The fake sandbox with scripted bash answers; files still go through the fake's own store. */
export class ScriptedSandboxProvider extends FakeSandboxProvider {
  readonly commands: string[] = [];

  constructor(private readonly answer: Answer) {
    super();
  }

  override async *execute(
    _computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const command = request.argv[2] ?? "";
    this.commands.push(command);
    const result = this.answer(command);
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.code };
  }
}

/** A provisioned computer on a scripted sandbox, with a reader for the files written to it. */
export async function scriptedComputer(answer: Answer) {
  const sandbox = new ScriptedSandboxProvider(answer);
  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  const computer = await sandbox.provision({ botId: "home", homePath: "/unused" }, context);
  const text = async (path: string) =>
    new TextDecoder().decode(await sandbox.readFile(computer, path, context));
  return { sandbox, computer, context, text };
}
```

`packages/testkit/src/computer-fixture-server.test.ts`:

```ts
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
    const { sandbox, computer, context } = await scriptedComputer(() => ({ code: 0, stdout: "out" }));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/computer-fixture-server.test.ts`
Expected: FAIL. The module `./computer-fixture-server.js` does not exist.

- [ ] **Step 3: Write the helper**

`packages/testkit/src/computer-fixture-server.ts`:

```ts
import assert from "node:assert/strict";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";

/** A local website a test runs inside a bot's computer. */
export type FixtureServer = {
  /** Home-relative paths and their contents, written before `command` runs. */
  files: Record<string, string>;
  /** Starts the server in the background and returns once it is launched. */
  command: string;
  /** Polled from inside the computer until it answers. */
  readyUrl: string;
  /** The server's output, quoted when it never becomes ready. */
  logPath: string;
};

/** Runs a bash command in the computer and returns its stdout; a non-zero exit throws. */
export async function executeChecked(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  command: string,
): Promise<string> {
  let code: number | undefined;
  let stdout = "";
  let stderr = "";
  for await (const event of sandbox.execute(computer, { argv: ["bash", "-c", command] }, context)) {
    if (event.type === "exit") code = event.code;
    else if (event.type === "stdout") stdout += event.data;
    else stderr += event.data;
  }
  assert.equal(code, 0, `Fixture command failed: ${stderr.slice(0, 1000)}`);
  return stdout;
}

export async function startFixtureServer(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  server: FixtureServer,
) {
  for (const [path, text] of Object.entries(server.files))
    await sandbox.writeFile(computer, { path, content: new TextEncoder().encode(text) }, context);
  await executeChecked(sandbox, computer, context, server.command);
  let readinessError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await executeChecked(
        sandbox,
        computer,
        context,
        `python3 -c 'import urllib.request; urllib.request.urlopen("${server.readyUrl}", timeout=1).read()'`,
      );
      return;
    } catch (error) {
      readinessError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const log = await executeChecked(sandbox, computer, context, `cat ${server.logPath}`).catch(
    () => "",
  );
  throw new Error(
    `Fixture server did not become ready: ${log.slice(0, 1000)} (${String(readinessError)})`,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/testkit/src/computer-fixture-server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Switch the contacts fixture to the helper**

In `packages/testkit/src/computer-replay-fixture.ts`:
- Keep `contactsPage`, the `page` script and the Python `source` string exactly as they are.
- Replace everything from `await sandbox.writeFile(` to the end of `installContactsFixture` with the code below.
- Delete the private `executeChecked` at the bottom of the file.
- Remove the `assert` import only if nothing else in the file uses it. Check with `grep -n "assert\." packages/testkit/src/computer-replay-fixture.ts`: `ContactsBrowserFixture.navigate` uses `assert.equal`, so it most likely stays.
- Add `import { startFixtureServer } from "./computer-fixture-server.js";`.

```ts
  await startFixtureServer(sandbox, computer, context, {
    files: { "contacts_server.py": source },
    command:
      "mkdir -p Downloads results; setsid -f python3 contacts_server.py > contacts-server.log 2>&1 < /dev/null",
    readyUrl: EXPORT_FIXTURE_URL,
    logPath: "contacts-server.log",
  });
}
```

- [ ] **Step 6: Run the contacts tests and lint**

Run:
```bash
pnpm exec vitest run packages/testkit/src/computer-replay.test.ts packages/testkit/src/computer-recording.test.ts packages/testkit/src/computer-fixture-server.test.ts
pnpm exec biome check packages/testkit/src/computer-fixture-server.ts packages/testkit/src/computer-fixture-server.test.ts packages/testkit/src/scripted-sandbox.ts packages/testkit/src/computer-replay-fixture.ts
```
Expected: all PASS, and Biome reports no errors. If a test asserted the old message "Contacts fixture did not become ready", update it to "Fixture server did not become ready".

- [ ] **Step 7: Commit**

```bash
git add packages/testkit/src/computer-fixture-server.ts packages/testkit/src/computer-fixture-server.test.ts packages/testkit/src/scripted-sandbox.ts packages/testkit/src/computer-replay-fixture.ts
git commit -m "test(testkit): share the in-computer fixture server between fixtures"
```

---

### Task 2: Shared Docker computer helper

Extract the supervisor startup (written out inline in `computer-replay.docker.test.ts`) and the pinned Docker settings (written out inline in `cli/computer-replay.ts`) into one module. Add `destroyComputers` for eval cleanup.

**Files:**
- Create: `packages/testkit/src/docker-computers.ts`
- Test: `packages/testkit/src/docker-computers.test.ts`
- Modify: `packages/testkit/src/cli/computer-replay.ts:38-72` (image check and env block)
- Modify: `packages/testkit/src/computer-replay.docker.test.ts:38-53` and `:196-204` (inline supervisor serve and close)

**Interfaces:**
- Produces:
  - `DEFAULT_COMPUTER_IMAGE = "rakazo/computer:local"`
  - `dockerComputerEnv(dataDir: string, image: string): Record<string, string>`
  - `assertComputerImage(image: string): void`, which throws `The computer image <image> is missing; build it with pnpm sandbox:build`
  - `serveSupervisor(): Promise<{ url: string; close(): Promise<void> }>`
  - `destroyComputers(prisma: Pick<ReturnType<typeof createDb>["prisma"], "computer">, sandbox: SandboxProvider): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`packages/testkit/src/docker-computers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/docker-computers.test.ts`
Expected: FAIL. The module `./docker-computers.js` does not exist.

- [ ] **Step 3: Write the module**

`packages/testkit/src/docker-computers.ts`:

```ts
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { createDb } from "@rakazo/db";

export const DEFAULT_COMPUTER_IMAGE = "rakazo/computer:local";

/** The same Prisma client type the eval runner's EvalApp uses. */
type Prisma = ReturnType<typeof createDb>["prisma"];

/** Settings a test's supervisor and API read, pinned so a developer's .env cannot change them. */
export function dockerComputerEnv(dataDir: string, image: string): Record<string, string> {
  return {
    DATA_DIR: dataDir,
    RAKAZO_COMPUTER_IMAGE: image,
    SANDBOX_PROVIDER: "docker",
    SANDBOX_SCREEN_NETWORK: "published",
    SANDBOX_SCREEN_HOST: "127.0.0.1",
    SANDBOX_CONTROL_VIA_LOOPBACK: "true",
    SANDBOX_IDLE_MS: "0",
    SANDBOX_COMPUTER_EGRESS: "open",
  };
}

export function assertComputerImage(image: string) {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  } catch {
    throw new Error(`The computer image ${image} is missing; build it with pnpm sandbox:build`);
  }
}

/** Serves the supervisor in this process. It reads process.env on import, so set that first. */
export async function serveSupervisor() {
  // Deferred: importing the supervisor reads its environment and connects to Docker.
  const { supervisorApp } = await import("../../../infra/sandboxes/supervisor/src/index.js");
  const server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
            ? reject(error)
            : resolve(),
        );
        server.closeAllConnections();
      }),
  };
}

/** Destroys every provisioned computer in this database; destroying a removed one is a no-op. */
export async function destroyComputers(prisma: Pick<Prisma, "computer">, sandbox: SandboxProvider) {
  // Deferred: the replay CLI imports this module and must stay free of the generated database client.
  const { toComputerRef } = await import("@rakazo/adapters");
  const computers = await prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, spaceId: true, userId: true },
  });
  const results = await Promise.allSettled(
    computers.map((computer) =>
      sandbox.destroy(toComputerRef(computer), {
        operationId: "eval-cleanup",
        traceId: "eval-cleanup",
        spaceId: computer.spaceId,
        userId: computer.userId,
        signal: AbortSignal.timeout(60_000),
      }),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Could not destroy every eval computer");
}
```

If `server.closeAllConnections` doesn't type-check on Hono's `ServerType` union, copy the exact form the replay test used, which type-checks today, so no cast is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/testkit/src/docker-computers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Switch the replay CLI and test to the helper**

`packages/testkit/src/cli/computer-replay.ts`:
- Replace `execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });` with `assertComputerImage(image);`.
- In `Object.assign(env, {...})`, replace these five keys with a spread of `...dockerComputerEnv(path.join(directory, "data"), image),`:
  - `DATA_DIR`
  - `RAKAZO_COMPUTER_IMAGE`
  - `SANDBOX_SCREEN_NETWORK`
  - `SANDBOX_SCREEN_HOST`
  - `SANDBOX_CONTROL_VIA_LOOPBACK`
- Keep `RUN_COMPUTER_REPLAY_DOCKER`, `SANDBOX_SUPERVISOR_TOKEN`, `LOG_LEVEL` and the subnet and record spreads.
- Add `import { assertComputerImage, dockerComputerEnv } from "../docker-computers.js";`.
- Drop the `execFileSync` import if it's now unused.

`packages/testkit/src/computer-replay.docker.test.ts`:
- Replace the block from `const { supervisorApp } = await import(...)` through the `new DockerSandboxProvider(...)` construction with:

  ```ts
  const supervisor = await serveSupervisor();
  try {
    const sandbox = new DockerSandboxProvider(supervisor.url, process.env.SANDBOX_SUPERVISOR_TOKEN);
  ```
- Replace the outer `finally { await new Promise<void>(... server.close ...) }` with `finally { await supervisor.close(); }`.
- Add `import { serveSupervisor } from "./docker-computers.js";`.
- Remove the now-unused imports `serve` and `AddressInfo`.

- [ ] **Step 6: Typecheck, lint and run the affected tests**

Run:
```bash
pnpm --filter @rakazo/testkit check
pnpm exec biome check packages/testkit/src/docker-computers.ts packages/testkit/src/docker-computers.test.ts packages/testkit/src/cli/computer-replay.ts packages/testkit/src/computer-replay.docker.test.ts
pnpm exec vitest run packages/testkit/src/docker-computers.test.ts packages/testkit/src/computer-replay.docker.test.ts
```
Expected:
- **Typecheck:** clean.
- **Biome:** clean.
- **Tests:** the docker test reports skipped, since `RUN_COMPUTER_REPLAY_DOCKER` is unset, and the helper tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/testkit/src/docker-computers.ts packages/testkit/src/docker-computers.test.ts packages/testkit/src/cli/computer-replay.ts packages/testkit/src/computer-replay.docker.test.ts
git commit -m "test(testkit): share Docker computer startup and cleanup"
```

---

### Task 3: Synthetic sites, their server and a local test harness

**Files:**
- Create: `packages/testkit/src/evals/browsing/sites.json`
- Create: `packages/testkit/src/evals/browsing/site_server.py`
- Create: `packages/testkit/src/evals/browsing/sites.ts`
- Create: `packages/testkit/src/evals/browsing/local-site-server.ts` (test helper)
- Test: `packages/testkit/src/evals/browsing/site-server.test.ts`

**Interfaces:**
- Produces, from `sites.ts`:
  - `SITES_PATH`, `SITE_SERVER_PATH` (absolute paths);
  - `SITE_PORT = 8800`, `SITE_URL = "http://127.0.0.1:8800"`;
  - `type Product`, `type BrowsingSites`, `type SiteRequest`;
  - `loadSites(): BrowsingSites`, `formatPrice(product: Product): string`, `parseSiteRequests(text: string): SiteRequest[]`.
- Produces, from `local-site-server.ts`: `startLocalSiteServer(): Promise<{ url: string; requests(): SiteRequest[]; close(): void }>`.

- [ ] **Step 1: Write the data**

`packages/testkit/src/evals/browsing/sites.json`. It's built so that:
- **Jackets:** the cheapest qualifying jacket, Kestrel Rain Jacket at $72, is on page 2 of the 14 jackets sorted by name. Page 1 holds three cheaper decoys that each fail one condition.
- **Hiking boots:** three of them, plus a non-hiking boot decoy.
- **Article:** the year is only in the late section.

```json
{
  "version": "browsing-v1",
  "shop": {
    "pageSize": 10,
    "products": [
      { "id": "alder-rain-shell", "name": "Alder Rain Shell", "category": "jackets", "price": 59, "waterproof": true, "sizes": ["S", "M", "L"], "inStock": false, "specs": { "weight": "380 g" } },
      { "id": "birch-windbreaker", "name": "Birch Windbreaker", "category": "jackets", "price": 49, "waterproof": false, "sizes": ["S", "M", "L"], "inStock": true, "specs": { "weight": "240 g" } },
      { "id": "cedar-storm-jacket", "name": "Cedar Storm Jacket", "category": "jackets", "price": 64, "waterproof": true, "sizes": ["S", "L"], "inStock": true, "specs": { "weight": "450 g" } },
      { "id": "dune-insulated-parka", "name": "Dune Insulated Parka", "category": "jackets", "price": 189, "waterproof": true, "sizes": ["S", "M", "L"], "inStock": true, "specs": { "weight": "910 g" } },
      { "id": "elm-softshell", "name": "Elm Softshell", "category": "jackets", "price": 119, "waterproof": false, "sizes": ["M", "L"], "inStock": true, "specs": { "weight": "520 g" } },
      { "id": "fjord-hardshell", "name": "Fjord Hardshell", "category": "jackets", "price": 149, "waterproof": true, "sizes": ["S", "M", "L"], "inStock": true, "specs": { "weight": "430 g" } },
      { "id": "glacier-down-jacket", "name": "Glacier Down Jacket", "category": "jackets", "price": 229, "waterproof": false, "sizes": ["S", "M"], "inStock": true, "specs": { "weight": "610 g" } },
      { "id": "heath-trail-jacket", "name": "Heath Trail Jacket", "category": "jackets", "price": 99, "waterproof": true, "sizes": ["M", "L"], "inStock": true, "specs": { "weight": "400 g" } },
      { "id": "iris-packable-shell", "name": "Iris Packable Shell", "category": "jackets", "price": 89, "waterproof": true, "sizes": ["S", "M"], "inStock": true, "specs": { "weight": "210 g" } },
      { "id": "juniper-field-jacket", "name": "Juniper Field Jacket", "category": "jackets", "price": 139, "waterproof": true, "sizes": ["M", "L", "XL"], "inStock": true, "specs": { "weight": "700 g" } },
      { "id": "kestrel-rain-jacket", "name": "Kestrel Rain Jacket", "category": "jackets", "price": 72, "waterproof": true, "sizes": ["S", "M", "L"], "inStock": true, "specs": { "weight": "360 g" } },
      { "id": "larch-fleece-jacket", "name": "Larch Fleece Jacket", "category": "jackets", "price": 55, "waterproof": false, "sizes": ["S", "M", "L"], "inStock": true, "specs": { "weight": "330 g" } },
      { "id": "moss-waxed-jacket", "name": "Moss Waxed Jacket", "category": "jackets", "price": 79, "waterproof": true, "sizes": ["M"], "inStock": true, "specs": { "weight": "880 g" } },
      { "id": "nimbus-ultralight-shell", "name": "Nimbus Ultralight Shell", "category": "jackets", "price": 69, "waterproof": true, "sizes": ["S", "L"], "inStock": true, "specs": { "weight": "180 g" } },
      { "id": "basalt-hiking-boot", "name": "Basalt Hiking Boot", "category": "boots", "price": 145, "waterproof": true, "sizes": ["40", "41", "42", "43", "44"], "inStock": true, "specs": { "weight": "1.1 kg", "drop": "8 mm" } },
      { "id": "ridge-hiking-boot", "name": "Ridge Hiking Boot", "category": "boots", "price": 129, "waterproof": false, "sizes": ["40", "41", "42", "43"], "inStock": true, "specs": { "weight": "0.9 kg", "drop": "6 mm" } },
      { "id": "summit-hiking-boot", "name": "Summit Hiking Boot", "category": "boots", "price": 169, "waterproof": true, "sizes": ["41", "42", "43", "44", "45"], "inStock": true, "specs": { "weight": "1.3 kg", "drop": "10 mm" } },
      { "id": "harbor-rain-boot", "name": "Harbor Rain Boot", "category": "boots", "price": 59, "waterproof": true, "sizes": ["39", "40", "41", "42"], "inStock": true, "specs": { "weight": "1.4 kg", "drop": "0 mm" } },
      { "id": "trail-thermos-750", "name": "Trail Thermos 750", "category": "accessories", "price": 24, "waterproof": false, "sizes": [], "inStock": true, "specs": { "weight": "410 g" } },
      { "id": "trail-thermos-500", "name": "Trail Thermos 500", "category": "accessories", "price": 19, "waterproof": false, "sizes": [], "inStock": true, "specs": { "weight": "320 g" } },
      { "id": "camp-mug", "name": "Camp Mug", "category": "accessories", "price": 12, "waterproof": false, "sizes": [], "inStock": true, "specs": { "weight": "150 g" } },
      { "id": "lumen-headlamp", "name": "Lumen Headlamp", "category": "accessories", "price": 35, "waterproof": true, "sizes": [], "inStock": true, "specs": { "weight": "90 g" } },
      { "id": "ridgeline-trekking-poles", "name": "Ridgeline Trekking Poles", "category": "accessories", "price": 59, "waterproof": false, "sizes": [], "inStock": false, "specs": { "weight": "520 g" } },
      { "id": "dry-bag-20l", "name": "Dry Bag 20L", "category": "accessories", "price": 29, "waterproof": true, "sizes": [], "inStock": true, "specs": { "weight": "110 g" } }
    ]
  },
  "checkout": { "shipping": ["standard", "express"] },
  "article": {
    "title": "The Kestrel Ridge Trail",
    "sections": [
      { "heading": "Overview", "text": "The Kestrel Ridge trail climbs 900 metres over twelve kilometres of mixed forest and open ridge. Most walkers finish it in five to six hours." },
      { "heading": "Getting there", "text": "The trailhead car park fills early on weekends. A seasonal bus runs from the valley station every ninety minutes." },
      { "heading": "The forest section", "text": "The first four kilometres follow an old logging road, widened in 1955 when the sawmill reopened." },
      { "heading": "The ridge", "text": "Above the tree line the path is exposed. Check the forecast; afternoon storms are common in summer." },
      { "heading": "The hut", "text": "A stone hut built in 1902 offers shelter halfway along the ridge. It has no water source." },
      { "heading": "Wildlife", "text": "Kestrels nest on the southern cliffs from April to July, which gave the ridge its name." },
      { "heading": "Seasons", "text": "Snow can linger on the north side into June. Autumn brings the clearest views." },
      { "heading": "Safety", "text": "Carry a map and a headlamp. Phone coverage drops out between the hut and the summit cairn." }
    ],
    "lateSection": { "heading": "History", "text": "Surveyors first mapped the Kestrel Ridge trail in 1887, following a shepherds' route between the two valleys." },
    "factYear": "1887",
    "lateDelayMs": 3000
  }
}
```

- [ ] **Step 2: Write `sites.ts` and the local harness**

`packages/testkit/src/evals/browsing/sites.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SITES_PATH = fileURLToPath(new URL("./sites.json", import.meta.url));
export const SITE_SERVER_PATH = fileURLToPath(new URL("./site_server.py", import.meta.url));
export const SITE_PORT = 8800;
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;

export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  waterproof: boolean;
  sizes: string[];
  inStock: boolean;
  specs: Record<string, string>;
};
type Section = { heading: string; text: string };
export type BrowsingSites = {
  version: string;
  shop: { pageSize: number; products: Product[] };
  checkout: { shipping: string[] };
  article: {
    title: string;
    sections: Section[];
    lateSection: Section;
    factYear: string;
    lateDelayMs: number;
  };
};
/** One line of the site server's request log. */
export type SiteRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  fields: Record<string, string>;
  userAgent: string;
  orderNumber?: string;
};

export function loadSites(): BrowsingSites {
  return JSON.parse(readFileSync(SITES_PATH, "utf8")) as BrowsingSites;
}

/** The shop's price format; site_server.py renders the same. */
export function formatPrice(product: Product) {
  return `$${product.price.toFixed(2)}`;
}

export function parseSiteRequests(text: string): SiteRequest[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SiteRequest);
}
```

`packages/testkit/src/evals/browsing/local-site-server.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SiteRequest } from "./sites.js";
import { parseSiteRequests, SITE_SERVER_PATH, SITES_PATH } from "./sites.js";

/** Runs site_server.py on the host for offline tests; the benchmark runs the same file in the computer. */
export async function startLocalSiteServer() {
  const port = await freePort();
  const directory = mkdtempSync(path.join(tmpdir(), "rakazo-sites-"));
  const logPath = path.join(directory, "requests.jsonl");
  const child = spawn("python3", [SITE_SERVER_PATH, SITES_PATH, String(port), logPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  const close = () => {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  };
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (attempt >= 50 || child.exitCode !== null) {
      close();
      throw new Error(`Site server did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    requests: (): SiteRequest[] =>
      existsSync(logPath) ? parseSiteRequests(readFileSync(logPath, "utf8")) : [],
    close,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
```

- [ ] **Step 3: Write the failing server tests**

`packages/testkit/src/evals/browsing/site-server.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalSiteServer } from "./local-site-server.js";
import { loadSites } from "./sites.js";

const sites = loadSites();
let server: Awaited<ReturnType<typeof startLocalSiteServer>>;
const get = async (path: string) => (await fetch(`${server.url}${path}`)).text();
const post = (path: string, fields: Record<string, string>) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "test-agent" },
    body: new URLSearchParams(fields).toString(),
  });
const listed = (html: string) => html.match(/<li>/g)?.length ?? 0;
const ORDER = {
  item: "trail-thermos-750",
  name: "Sam Example",
  street: "1 Test Street",
  city: "Testville",
  postcode: "00000",
};

beforeAll(async () => {
  server = await startLocalSiteServer();
});
afterAll(() => server.close());

describe("site server", () => {
  it("pages a category from sites.json, sorted by name", async () => {
    const first = await get("/shop?category=jackets");
    expect(first).toContain("Page 1 of 2");
    expect(listed(first)).toBe(10);
    expect(first).toContain("Alder Rain Shell");
    const second = await get("/shop?category=jackets&page=2");
    expect(second).toContain("Kestrel Rain Jacket</a> $72.00");
    expect(listed(second)).toBe(4);
  });

  it("searches product names", async () => {
    const html = await get("/shop?q=thermos");
    expect(listed(html)).toBe(2);
    expect(html).toContain("Trail Thermos 750");
  });

  it("falls back to page 1 for a bad page number", async () => {
    expect(await get("/shop?category=jackets&page=abc")).toContain("Page 1 of 2");
  });

  it("shows sizes, stock and specs only on the product page", async () => {
    expect(await get("/shop?category=jackets")).not.toContain("Sizes:");
    const page = await get("/shop/item/kestrel-rain-jacket");
    expect(page).toContain("Sizes: S, M, L");
    expect(page).toContain("In stock");
    expect(page).toContain("Waterproof: Yes");
    expect(await get("/shop/item/basalt-hiking-boot")).toContain("<td>8 mm</td>");
  });

  it("logs one confirmed order with the number it shows", async () => {
    const details = await post("/checkout/details", ORDER);
    expect(await details.text()).toContain("Step 2 of 2");
    const confirm = await post("/checkout/confirm", {
      ...ORDER,
      quantity: "2",
      shipping: "standard",
    });
    const html = await confirm.text();
    const logged = server.requests().filter((r) => r.path === "/checkout/confirm");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.orderNumber).toMatch(/^TO-[0-9A-F]{6}$/);
    expect(html).toContain(logged[0]!.orderNumber!);
    expect(logged[0]).toMatchObject({
      method: "POST",
      userAgent: "test-agent",
      fields: { ...ORDER, quantity: "2", shipping: "standard" },
    });
  });

  it("refuses an incomplete order without issuing a number", async () => {
    const before = server.requests().length;
    const response = await post("/checkout/confirm", {
      item: "trail-thermos-750",
      quantity: "1",
      shipping: "standard",
    });
    expect(response.status).toBe(400);
    expect(server.requests().slice(before).every((r) => !r.orderNumber)).toBe(true);
  });

  it("keeps the article behind the banner and serves the late section separately", async () => {
    const article = await get("/article");
    expect(article).toContain("id='cookie-banner'");
    expect(article).toContain("<main id='article' hidden>");
    expect(article).not.toContain(sites.article.factYear);
    expect(await get("/article/late")).toContain(sites.article.factYear);
  });

  it("does not log health checks", async () => {
    await get("/health");
    expect(server.requests().some((r) => r.path === "/health")).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/evals/browsing/site-server.test.ts`
Expected: FAIL in `beforeAll` with "Site server did not start", because `site_server.py` does not exist.

- [ ] **Step 5: Write the server**

`packages/testkit/src/evals/browsing/site_server.py`:

```python
"""Synthetic sites for the browsing benchmark.

Usage: site_server.py <sites.json> <port> <requests.jsonl>
Pages render from sites.json. Every request except /health is appended to the log.
"""

import html
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

DATA_PATH, PORT, LOG_PATH = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(DATA_PATH, encoding="utf-8") as data_file:
    SITES = json.load(data_file)
PRODUCTS = sorted(SITES["shop"]["products"], key=lambda product: product["name"])
PRODUCTS_BY_ID = {product["id"]: product for product in PRODUCTS}
PAGE_SIZE = SITES["shop"]["pageSize"]
CHECKOUT_FIELDS = ("name", "street", "city", "postcode")


def esc(value):
    return html.escape(str(value), quote=True)


def document(title, body, script=""):
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        f"<title>{esc(title)}</title></head><body>{body}{script}</body></html>"
    )


def price(product):
    return f"${product['price']:.2f}"


def first(values, name, default=""):
    return values.get(name, [default])[0].strip()


def page_number(raw):
    return int(raw) if raw.isdigit() and int(raw) > 0 else 1


def shop_page(query):
    text = first(query, "q")
    category = first(query, "category")
    matches = [
        product
        for product in PRODUCTS
        if (not text or text.lower() in product["name"].lower())
        and (not category or product["category"] == category)
    ]
    pages = max(1, -(-len(matches) // PAGE_SIZE))
    number = min(page_number(first(query, "page", "1")), pages)
    shown = matches[(number - 1) * PAGE_SIZE : number * PAGE_SIZE]
    options = "".join(
        f"<option value='{esc(name)}'{' selected' if name == category else ''}>{esc(name.title())}</option>"
        for name in sorted({product["category"] for product in PRODUCTS})
    )
    items = "".join(
        f"<li><a href='/shop/item/{esc(product['id'])}'>{esc(product['name'])}</a> {price(product)}</li>"
        for product in shown
    )

    def link(target, label):
        query_string = urlencode({"q": text, "category": category, "page": target})
        return f"<a href='/shop?{esc(query_string)}'>{label}</a> "

    nav = (link(number - 1, "Previous page") if number > 1 else "") + (
        link(number + 1, "Next page") if number < pages else ""
    )
    body = (
        "<h1>Trailhead Outfitters</h1><form action='/shop'>"
        f"<label>Search <input name='q' value='{esc(text)}'></label> "
        f"<label>Category <select name='category'><option value=''>All</option>{options}</select></label> "
        "<button>Search</button></form>"
        f"<p>Page {number} of {pages} ({len(matches)} products)</p><ul>{items}</ul><nav>{nav}</nav>"
    )
    return document("Shop", body)


def item_page(product):
    specs = "".join(
        f"<tr><th>{esc(name.title())}</th><td>{esc(value)}</td></tr>"
        for name, value in product["specs"].items()
    )
    buy = f"<p><a href='/checkout?item={esc(product['id'])}'>Buy</a></p>" if product["inStock"] else ""
    body = (
        f"<h1>{esc(product['name'])}</h1><p>{price(product)}</p>"
        f"<p>Waterproof: {'Yes' if product['waterproof'] else 'No'}</p>"
        f"<p>Sizes: {esc(', '.join(product['sizes']) or 'One size')}</p>"
        f"<p>{'In stock' if product['inStock'] else 'Out of stock'}</p>"
        f"<table><caption>Specs</caption>{specs}</table>{buy}"
        "<p><a href='/shop'>Back to shop</a></p>"
    )
    return document(product["name"], body)


def hidden(fields):
    return "".join(
        f"<input type='hidden' name='{esc(name)}' value='{esc(value)}'>" for name, value in fields.items()
    )


def checkout_details(product):
    inputs = "".join(
        f"<p><label>{esc(name.title())} <input name='{name}' required></label></p>" for name in CHECKOUT_FIELDS
    )
    body = (
        f"<h1>Checkout: {esc(product['name'])}</h1><h2>Step 1 of 2: Your details</h2>"
        f"<form method='post' action='/checkout/details'>{hidden({'item': product['id']})}{inputs}"
        "<button>Continue</button></form>"
    )
    return document("Checkout", body)


def checkout_options(fields):
    product = PRODUCTS_BY_ID[fields["item"]]
    carried = {name: fields[name] for name in ("item", *CHECKOUT_FIELDS)}
    shipping = "".join(
        f"<option value='{esc(option)}'>{esc(option.title())}</option>" for option in SITES["checkout"]["shipping"]
    )
    body = (
        f"<h1>Checkout: {esc(product['name'])}</h1><h2>Step 2 of 2: Quantity and shipping</h2>"
        f"<form method='post' action='/checkout/confirm'>{hidden(carried)}"
        "<p><label>Quantity <input name='quantity' type='number' min='1' value='1'></label></p>"
        f"<p><label>Shipping <select name='shipping'>{shipping}</select></label></p>"
        "<button>Place order</button></form>"
    )
    return document("Checkout", body)


def confirmation(order_number):
    body = f"<h1>Order confirmed</h1><p>Your order number is <strong>{esc(order_number)}</strong>.</p>"
    return document("Order confirmed", body)


def article_page():
    article = SITES["article"]
    sections = "".join(
        f"<section><h2>{esc(section['heading'])}</h2><p>{esc(section['text'])}</p></section>"
        for section in article["sections"]
    )
    body = (
        "<div id='cookie-banner' role='dialog' aria-label='Cookie consent'>"
        "<p>We use cookies to improve this site.</p><button id='accept-cookies'>Accept cookies</button></div>"
        f"<main id='article' hidden><h1>{esc(article['title'])}</h1>{sections}"
        "<div id='late'><p>Loading more…</p></div></main>"
    )
    script = (
        "<script>document.getElementById('accept-cookies').onclick = () => {"
        "document.getElementById('cookie-banner').remove();"
        "document.getElementById('article').hidden = false;"
        "setTimeout(async () => { document.getElementById('late').innerHTML = "
        f"await (await fetch('/article/late')).text(); }}, {int(article['lateDelayMs'])});"
        "};</script>"
    )
    return document(article["title"], body, script)


def late_fragment():
    late = SITES["article"]["lateSection"]
    return f"<section><h2>{esc(late['heading'])}</h2><p>{esc(late['text'])}</p></section>"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def record(self, path, query, fields, order_number=None):
        entry = {
            "method": self.command,
            "path": path,
            "query": {name: values[0] for name, values in query.items()},
            "fields": fields,
            "userAgent": self.headers.get("User-Agent", ""),
        }
        if order_number:
            entry["orderNumber"] = order_number
        with open(LOG_PATH, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")

    def reply(self, status, content, content_type="text/html; charset=utf-8"):
        payload = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.reply(200, "ok", "text/plain; charset=utf-8")
        query = parse_qs(url.query)
        self.record(url.path, query, {})
        item = url.path.removeprefix("/shop/item/")
        if url.path in ("/", "/shop"):
            return self.reply(200, shop_page(query))
        if url.path.startswith("/shop/item/") and item in PRODUCTS_BY_ID:
            return self.reply(200, item_page(PRODUCTS_BY_ID[item]))
        if url.path == "/checkout" and first(query, "item") in PRODUCTS_BY_ID:
            return self.reply(200, checkout_details(PRODUCTS_BY_ID[first(query, "item")]))
        if url.path == "/article":
            return self.reply(200, article_page())
        if url.path == "/article/late":
            return self.reply(200, late_fragment())
        self.reply(404, document("Not found", "<h1>Not found</h1><p><a href='/shop'>Shop</a></p>"))

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        submitted = parse_qs(self.rfile.read(length).decode("utf-8"))
        fields = {name: values[0].strip() for name, values in submitted.items()}
        complete = fields.get("item") in PRODUCTS_BY_ID and all(fields.get(name) for name in CHECKOUT_FIELDS)
        if url.path == "/checkout/details" and complete:
            self.record(url.path, {}, fields)
            return self.reply(200, checkout_options(fields))
        if (
            url.path == "/checkout/confirm"
            and complete
            and fields.get("quantity", "").isdigit()
            and fields.get("shipping") in SITES["checkout"]["shipping"]
        ):
            order_number = f"TO-{secrets.token_hex(3).upper()}"
            self.record(url.path, {}, fields, order_number)
            return self.reply(200, confirmation(order_number))
        self.record(url.path, {}, fields)
        self.reply(400, document("Check your details", "<h1>Some details are missing</h1><p><a href='/shop'>Back to shop</a></p>"))


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/testkit/src/evals/browsing/site-server.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Lint and commit**

Run: `pnpm exec biome check packages/testkit/src/evals/browsing/ && python3 -m py_compile packages/testkit/src/evals/browsing/site_server.py`
Expected: clean. If Biome reformats `sites.json`, accept its formatting.

```bash
git add packages/testkit/src/evals/browsing/
git commit -m "test(evals): synthetic browsing sites rendered from one data file"
```

---

### Task 4: Runner and report hooks

**Files:**
- Modify: `packages/testkit/src/evals/cases.ts` (`Evidence` at lines 16-36, `EvalCase` at lines 38-51, `const check` at line 52)
- Modify: `packages/testkit/src/evals/runner.ts`:
  - `TrialOptions` at lines 47-57;
  - `setupActor` at lines 148-197;
  - after `await setupActor();`;
  - Evidence assembly at lines 600-638;
  - the `finally` block at lines 667-765.
- Modify: `packages/testkit/src/evals/report.ts` (`TrialResult` at lines 9-49, `summarize` at lines 51-120)
- Test: `packages/testkit/src/evals/evals.test.ts` (extend; it already tests `summarize`)

**Interfaces:**
- Consumes: `SiteRequest` from Task 3 (`./browsing/sites.js`).
- Produces:
  - `export const check` in `cases.ts`;
  - `EvalCase.disabledBuiltinTools?: string[]`;
  - `Evidence.siteRequests?: SiteRequest[]`;
  - `export type ComputerFixture = { install(trial: EvalApp, botId: string): Promise<void>; siteRequests(trial: EvalApp, botId: string): Promise<SiteRequest[]> }` and `TrialOptions.computerFixture?: ComputerFixture`, in `runner.ts`;
  - `export type TrialTimings = { setupMs: number | null; bootMs: number | null; taskMs: number | null }`, `TrialResult.timings?: TrialTimings` and `export function taskMsFromRuns(runs: ReadonlyArray<{ startedAt: Date | null; completedAt: Date | null }>): number | null`, in `report.ts`;
  - `summarize` rows gain `taskMsP50` and `taskMsP95` when any attempted trial has a `taskMs`.

- [ ] **Step 1: Write the failing tests** (append to `packages/testkit/src/evals/evals.test.ts` and add `taskMsFromRuns` to its `./report.js` import)

```ts
describe("task timing", () => {
  const at = (ms: number) => new Date(ms);

  it("sums the task runs' own running time", () => {
    expect(
      taskMsFromRuns([
        { startedAt: at(1_000), completedAt: at(4_000) },
        { startedAt: at(10_000), completedAt: at(10_500) },
      ]),
    ).toBe(3_500);
  });

  it("has no task time when a run never started or finished", () => {
    expect(taskMsFromRuns([])).toBeNull();
    expect(taskMsFromRuns([{ startedAt: at(1), completedAt: null }])).toBeNull();
  });

  it("summarizes task time per case only when trials have it", () => {
    const timed = (taskMs: number) => ({
      ...emptyTrial("browse", 1),
      status: "passed" as const,
      timings: { setupMs: 1, bootMs: 2, taskMs },
    });
    expect(summarize([timed(1_000), timed(3_000)])[0]).toMatchObject({
      taskMsP50: 1_000,
      taskMsP95: 3_000,
    });
    expect(summarize([{ ...emptyTrial("plain", 1), status: "passed" }])[0]).not.toHaveProperty(
      "taskMsP50",
    );
  });
});
```

Before writing the assertions, check how `percentile` interpolates: it's at the bottom of `report.ts`, around line 203. If it uses nearest-rank on sorted values, the P50 of [1000, 3000] is 1000 and the P95 is 3000. If it interpolates, use the values it actually computes. A wrong expectation is a test bug, not a reason to change `percentile`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/evals/evals.test.ts -t "task timing"`
Expected: FAIL, because `taskMsFromRuns` is not exported.

- [ ] **Step 3: Implement the report pieces**

In `report.ts`:
- Add to `TrialResult`: `timings?: TrialTimings;`.
- Add:

```ts
export type TrialTimings = { setupMs: number | null; bootMs: number | null; taskMs: number | null };

/** How long a task's runs spent running, from the product's own run records. */
export function taskMsFromRuns(
  runs: ReadonlyArray<{ startedAt: Date | null; completedAt: Date | null }>,
): number | null {
  if (!runs.length || runs.some((run) => !run.startedAt || !run.completedAt)) return null;
  return runs.reduce(
    (total, run) => total + (run.completedAt!.getTime() - run.startedAt!.getTime()),
    0,
  );
}
```

In `summarize`, before `return {`, add `const taskTimes = attempted.flatMap((r) => (r.timings?.taskMs == null ? [] : [r.timings.taskMs]));`. Then add to the returned object, after `latencyP95Ms`:

```ts
      ...(taskTimes.length
        ? { taskMsP50: percentile(taskTimes, 0.5), taskMsP95: percentile(taskTimes, 0.95) }
        : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/testkit/src/evals/evals.test.ts`
Expected: PASS, including every existing test.

- [ ] **Step 5: Add the case fields and runner hook**

In `cases.ts`:
- Add `import type { SiteRequest } from "./browsing/sites.js";`.
- Add to `Evidence`: `siteRequests?: SiteRequest[];`.
- Add to `EvalCase`: `/** Built-in tools turned off for the trial's bot, by tool name. */ disabledBuiltinTools?: string[];`.
- Change `const check =` to `export const check =`.

In `runner.ts`:
- Add `import type { SiteRequest } from "./browsing/sites.js";` and `import type { TrialTimings } from "./report.js";`. Merge the type into the existing `report.js` type import, and add `taskMsFromRuns` to the value import from `./report.js`.
- Add the type after `EvalActor`:

```ts
/** A fixture installed in the trial bot's real computer after it boots, and the requests it saw. */
export type ComputerFixture = {
  install(trial: EvalApp, botId: string): Promise<void>;
  siteRequests(trial: EvalApp, botId: string): Promise<SiteRequest[]>;
};
```

- Add to `TrialOptions`: `computerFixture?: ComputerFixture;`.
- Next to `const runIds: string[] = [];`, add `const timings: TrialTimings = { setupMs: null, bootMs: null, taskMs: null };`.
- In `setupActor`, extend the existing `bots/update` call:

```ts
      await rpc(app, cookie, "bots/update", {
        botId,
        modelProvider: options.connection.provider,
        modelId: options.connection.modelId,
        ...(scenario.disabledBuiltinTools
          ? { disabledBuiltinTools: scenario.disabledBuiltinTools }
          : {}),
      });
```

- Next to `const timings`, add one wrapper, so a broken computer or site is never blamed on the model:

```ts
  const asHarness = async <T>(label: string, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      throw new EvalFailure(
        "harness",
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
```

- Replace the first `await setupActor();` (the one right after the `setupActor` definition) with:

```ts
    const setupStarted = Date.now();
    await setupActor();
    timings.setupMs = Date.now() - setupStarted;
    const fixture = options.computerFixture;
    if (fixture) {
      const bootStarted = Date.now();
      await asHarness("Computer fixture setup failed", async () => {
        await rpc(app, cookie, "computer/boot", { botId });
        await fixture.install(trial, botId);
      });
      timings.bootMs = Date.now() - bootStarted;
    }
```

- In the Evidence object literal, after `toolNames`, add:

```ts
      ...(options.computerFixture
        ? {
            siteRequests: await asHarness("Reading the site log failed", () =>
              options.computerFixture!.siteRequests(trial, botId),
            ),
          }
        : {}),
```

- In the `finally` block inside `if (handles)`, right after the `await captureUsage().catch(...)` statement, add:

```ts
      try {
        const taskRunIds = runIds.filter((id) => !setupRunIds.has(id));
        timings.taskMs = taskMsFromRuns(
          await handles.prisma.run.findMany({
            where: { id: { in: taskRunIds } },
            select: { startedAt: true, completedAt: true },
          }),
        );
      } catch {
        // Task time stays null; the trial's outcome does not depend on it.
      }
      result.timings = timings;
```

- [ ] **Step 6: Typecheck and run the eval tests**

Run:
```bash
pnpm --filter @rakazo/testkit check
pnpm exec vitest run packages/testkit/src/evals/
pnpm exec biome check packages/testkit/src/evals/cases.ts packages/testkit/src/evals/runner.ts packages/testkit/src/evals/report.ts packages/testkit/src/evals/evals.test.ts
```
Expected: clean, and all pass. `trial` is the existing `const trial = handles;` in scope at the `setupActor` call site and the Evidence site. If it isn't in scope at either place, use `handles` (non-null there).

- [ ] **Step 7: Commit**

```bash
git add packages/testkit/src/evals/cases.ts packages/testkit/src/evals/runner.ts packages/testkit/src/evals/report.ts packages/testkit/src/evals/evals.test.ts
git commit -m "test(evals): task timings and an optional computer fixture per trial"
```

---

### Task 5: Browsing cases and graders

**Files:**
- Create: `packages/testkit/src/evals/browsing/cases.ts`
- Test: `packages/testkit/src/evals/browsing/cases.test.ts`

**Interfaces:**
- Consumes:
  - `check`, `EvalCase`, `Evidence`, `Criterion` from `../cases.js` (Task 4);
  - `loadSites`, `formatPrice`, `SITE_URL`, `Product`, `BrowsingSites` from `./sites.js` (Task 3);
  - `startLocalSiteServer` (Task 3, tests only).
- Produces:
  - `BROWSING_EVAL_CASES: EvalCase[]` (ids `browse-compare-cheapest`, `browse-form-checkout`, `browse-extract-csv`, `browse-hard-page`) and `BROWSING_FIXTURE_VERSION: string`;
  - `CHECKOUT_ORDER`, `BOOT_COLUMNS`, `qualifiesAsJacket`, `cheapestJacket(sites)`, `hikingBootRows(sites)`, `parseCsv(text)`.

- [ ] **Step 1: Write the failing tests**

`packages/testkit/src/evals/browsing/cases.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import {
  BOOT_COLUMNS,
  BROWSING_EVAL_CASES,
  CHECKOUT_ORDER,
  cheapestJacket,
  hikingBootRows,
  qualifiesAsJacket,
} from "./cases.js";
import { startLocalSiteServer } from "./local-site-server.js";
import type { SiteRequest } from "./sites.js";
import { formatPrice, loadSites } from "./sites.js";

const sites = loadSites();
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36";
const grade = (id: string, evidence: Partial<Evidence>) =>
  Object.fromEntries(
    BROWSING_EVAL_CASES.find((c) => c.id === id)!
      .grade({ text: "", files: {}, toolNames: ["browser_navigate"], siteRequests: [], ...evidence } as Evidence)
      .map((criterion) => [criterion.id, criterion.pass]),
  );
const request = (path: string, extra: Partial<SiteRequest> = {}): SiteRequest => ({
  method: "GET",
  path,
  query: {},
  fields: {},
  userAgent: CHROME,
  ...extra,
});
const confirm = (orderNumber: string, fields: Record<string, string> = CHECKOUT_ORDER) =>
  request("/checkout/confirm", { method: "POST", fields, orderNumber });

describe("one answer per task", () => {
  let server: Awaited<ReturnType<typeof startLocalSiteServer>>;
  beforeAll(async () => {
    server = await startLocalSiteServer();
  });
  afterAll(() => server.close());
  const page = async (path: string) => (await fetch(`${server.url}${path}`)).text();

  it("has one cheapest qualifying jacket, past page 1, behind cheaper decoys that each miss one condition", async () => {
    const answer = cheapestJacket(sites);
    const qualifying = sites.shop.products.filter(qualifiesAsJacket);
    expect(qualifying.filter((p) => p.price === answer.price)).toHaveLength(1);
    const decoys = sites.shop.products.filter(
      (p) => p.category === "jackets" && p.price < answer.price,
    );
    for (const decoy of decoys)
      expect(
        [decoy.waterproof, decoy.inStock, decoy.sizes.includes("M")].filter((ok) => !ok),
      ).toHaveLength(1);
    const first = await page("/shop?category=jackets");
    expect(first).not.toContain(answer.name);
    expect(decoys.filter((d) => first.includes(d.name)).length).toBeGreaterThanOrEqual(3);
    expect(await page("/shop?category=jackets&page=2")).toContain(
      `${answer.name}</a> ${formatPrice(answer)}`,
    );
  });

  it("shows each hiking boot's CSV values on its product page", async () => {
    const rows = hikingBootRows(sites);
    expect(rows).toHaveLength(3);
    for (const product of sites.shop.products.filter((p) => p.name.includes("Hiking Boot"))) {
      const html = await page(`/shop/item/${product.id}`);
      const [, weight, waterproof, drop] = rows.find(([name]) => name === product.name)!;
      expect(html).toContain(`<td>${weight}</td>`);
      expect(html).toContain(`<td>${drop}</td>`);
      expect(html).toContain(`Waterproof: ${waterproof}`);
    }
  });

  it("puts the article's year only in the late section", async () => {
    const { article } = sites;
    const elsewhere = [article.title, ...article.sections.map((s) => s.text)].join(" ");
    expect(article.lateSection.text).toContain(article.factYear);
    expect(elsewhere).not.toContain(article.factYear);
    expect(await page("/article/late")).toContain(article.factYear);
  });
});

describe("graders", () => {
  const answer = cheapestJacket(sites);
  const cheapest = `${answer.name} — ${formatPrice(answer)}`;

  it("passes the right jacket found through the browser", () => {
    expect(
      grade("browse-compare-cheapest", {
        files: { "results/cheapest.md": cheapest },
        siteRequests: [request("/shop")],
      }),
    ).toEqual({ "cheapest-jacket": true, "used-browser": true });
  });

  it("fails requests that did not come from Chrome, or no browser use at all", () => {
    const files = { "results/cheapest.md": cheapest };
    expect(
      grade("browse-compare-cheapest", {
        files,
        siteRequests: [request("/shop", { userAgent: "curl/8.0" })],
      })["used-browser"],
    ).toBe(false);
    expect(
      grade("browse-compare-cheapest", { files, toolNames: [], siteRequests: [request("/shop")] })[
        "used-browser"
      ],
    ).toBe(false);
  });

  it("passes one order reported by number and fails a double submit", () => {
    const one = grade("browse-form-checkout", {
      text: "Done, your order number is TO-ABC123.",
      siteRequests: [confirm("TO-ABC123")],
    });
    expect(one).toEqual({
      "one-order": true,
      "order-details": true,
      "order-number-reported": true,
      "used-browser": true,
    });
    const twice = grade("browse-form-checkout", {
      text: "TO-ABC123",
      siteRequests: [confirm("TO-ABC123"), confirm("TO-DEF456")],
    });
    expect(twice["one-order"]).toBe(false);
  });

  it("fails a wrong order number or wrong details", () => {
    expect(
      grade("browse-form-checkout", { text: "TO-000000", siteRequests: [confirm("TO-ABC123")] })[
        "order-number-reported"
      ],
    ).toBe(false);
    expect(
      grade("browse-form-checkout", {
        text: "TO-ABC123",
        siteRequests: [confirm("TO-ABC123", { ...CHECKOUT_ORDER, quantity: "1" })],
      })["order-details"],
    ).toBe(false);
  });

  it("accepts the boots CSV in any row order, header case, quoting and spacing", () => {
    const rows = hikingBootRows(sites);
    const csv = [
      BOOT_COLUMNS.map((c) => c.toUpperCase()).join(", "),
      ...[...rows].reverse().map((row) => row.map((cell) => ` "${cell}" `).join(",")),
    ].join("\n");
    expect(
      grade("browse-extract-csv", {
        files: { "results/boots.csv": csv },
        siteRequests: [request("/shop/item/basalt-hiking-boot")],
      }),
    ).toEqual({ "csv-header": true, "csv-rows": true, "used-browser": true });
    expect(
      grade("browse-extract-csv", {
        files: { "results/boots.csv": [BOOT_COLUMNS.join(","), rows[0]!.join(",")].join("\n") },
      })["csv-rows"],
    ).toBe(false);
  });

  it("needs the year and the late section for the hard page", () => {
    const files = { "results/fact.txt": `${sites.article.factYear}\n` };
    expect(
      grade("browse-hard-page", {
        files,
        siteRequests: [request("/article"), request("/article/late")],
      }),
    ).toEqual({ "fact-year": true, "late-section-loaded": true, "used-browser": true });
    expect(
      grade("browse-hard-page", { files, siteRequests: [request("/article")] })[
        "late-section-loaded"
      ],
    ).toBe(false);
  });

  it("runs every task with only the browser and no connected apps", () => {
    for (const scenario of BROWSING_EVAL_CASES) {
      expect(scenario.connections).toEqual([]);
      expect(scenario.disabledBuiltinTools).toEqual(["shell", "web_fetch", "web_search"]);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/evals/browsing/cases.test.ts`
Expected: FAIL, because `./cases.js` does not exist.

- [ ] **Step 3: Write the cases**

`packages/testkit/src/evals/browsing/cases.ts`:

```ts
import type { Criterion, EvalCase, Evidence } from "../cases.js";
import { check } from "../cases.js";
import type { BrowsingSites, Product } from "./sites.js";
import { formatPrice, loadSites, SITE_URL } from "./sites.js";

const SITES = loadSites();
export const BROWSING_FIXTURE_VERSION = SITES.version;

/** Shell and server-side web tools are off, so the browser is the only way to the sites. */
const BROWSER_ONLY = {
  connections: [] as string[],
  disabledBuiltinTools: ["shell", "web_fetch", "web_search"],
};

export const CHECKOUT_ORDER = {
  item: "trail-thermos-750",
  quantity: "2",
  shipping: "standard",
  name: "Sam Example",
  street: "1 Test Street",
  city: "Testville",
  postcode: "00000",
};
export const BOOT_COLUMNS = ["name", "weight", "waterproof", "drop"] as const;

export const qualifiesAsJacket = (product: Product) =>
  product.category === "jackets" &&
  product.waterproof &&
  product.inStock &&
  product.sizes.includes("M");

export function cheapestJacket(sites: BrowsingSites): Product {
  const [cheapest] = sites.shop.products.filter(qualifiesAsJacket).sort((a, b) => a.price - b.price);
  if (!cheapest) throw new Error("sites.json has no qualifying jacket");
  return cheapest;
}

export function hikingBootRows(sites: BrowsingSites): string[][] {
  return sites.shop.products
    .filter((product) => product.name.includes("Hiking Boot"))
    .map((product) => [
      product.name,
      product.specs.weight ?? "",
      product.waterproof ? "Yes" : "No",
      product.specs.drop ?? "",
    ]);
}

export function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim()));
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const rowKey = (row: readonly string[]) => row.map(normalize).join("|");
const file = (evidence: Evidence, name: string) => evidence.files[name]?.trim() ?? "";
const requestsTo = (evidence: Evidence, prefix: string) =>
  (evidence.siteRequests ?? []).filter((request) => request.path.startsWith(prefix));

/** The task reached the site, only through the computer's Chrome. */
function usedBrowser(evidence: Evidence, prefix: string): Criterion {
  const requests = requestsTo(evidence, prefix);
  return check(
    "used-browser",
    evidence.toolNames.some((name) => name.startsWith("browser_") || name.startsWith("computer_")) &&
      requests.length > 0 &&
      requests.every((request) => request.userAgent.includes("Chrome")),
  );
}

export const BROWSING_EVAL_CASES: EvalCase[] = [
  {
    id: "browse-compare-cheapest",
    purpose: "Search, filter and page through a shop for the cheapest item meeting three conditions.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, find the cheapest jacket that is waterproof, in stock and available in size M. Write it to results/cheapest.md as "<name> — <price>", for example "Example Jacket — $10.00".`,
      },
    ],
    files: ["results/cheapest.md"],
    grade: (evidence) => {
      const answer = cheapestJacket(SITES);
      const text = normalize(file(evidence, "results/cheapest.md"));
      return [
        check(
          "cheapest-jacket",
          text.includes(normalize(answer.name)) && text.includes(formatPrice(answer)),
        ),
        usedBrowser(evidence, "/shop"),
      ];
    },
  },
  {
    id: "browse-form-checkout",
    purpose: "Complete a two-step checkout exactly once and report the order number.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, buy the Trail Thermos 750: quantity ${CHECKOUT_ORDER.quantity}, ${CHECKOUT_ORDER.shipping} shipping, for ${CHECKOUT_ORDER.name}, ${CHECKOUT_ORDER.street}, ${CHECKOUT_ORDER.city}, postcode ${CHECKOUT_ORDER.postcode}. Place the order once, then tell me the order number.`,
      },
    ],
    grade: (evidence) => {
      const orders = requestsTo(evidence, "/checkout/confirm").filter(
        (request) => request.orderNumber,
      );
      const [order] = orders;
      return [
        check("one-order", orders.length === 1),
        check(
          "order-details",
          !!order &&
            Object.entries(CHECKOUT_ORDER).every(
              ([name, value]) => normalize(order.fields[name] ?? "") === normalize(value),
            ),
        ),
        check("order-number-reported", !!order?.orderNumber && evidence.text.includes(order.orderNumber)),
        usedBrowser(evidence, "/checkout"),
      ];
    },
  },
  {
    id: "browse-extract-csv",
    purpose: "Collect a specs table from several product pages into an exact CSV.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, find the three hiking boots and save their specs to results/boots.csv with the header ${BOOT_COLUMNS.join(",")} and one row per boot. Use the values exactly as the product pages show them; waterproof is Yes or No.`,
      },
    ],
    files: ["results/boots.csv"],
    grade: (evidence) => {
      const [header = [], ...rows] = parseCsv(file(evidence, "results/boots.csv"));
      const expected = hikingBootRows(SITES).map(rowKey);
      const found = new Set(rows.map(rowKey));
      return [
        check("csv-header", rowKey(header) === rowKey(BOOT_COLUMNS)),
        check(
          "csv-rows",
          rows.length === expected.length && expected.every((row) => found.has(row)),
        ),
        usedBrowser(evidence, "/shop"),
      ];
    },
  },
  {
    id: "browse-hard-page",
    purpose: "Get past a cookie banner, a long page and a late-loading section to one fact.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `Read the article at ${SITE_URL}/article. In what year was the trail first mapped? Save just the year to results/fact.txt.`,
      },
    ],
    files: ["results/fact.txt"],
    grade: (evidence) => [
      check("fact-year", file(evidence, "results/fact.txt") === SITES.article.factYear),
      check("late-section-loaded", requestsTo(evidence, "/article/late").length > 0),
      usedBrowser(evidence, "/article"),
    ],
  },
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/testkit/src/evals/browsing/`
Expected: PASS (the Task 3 server tests plus 10 here).

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec biome check packages/testkit/src/evals/browsing/`
Expected: clean. Accept Biome's formatting if it rewraps lines.

```bash
git add packages/testkit/src/evals/browsing/cases.ts packages/testkit/src/evals/browsing/cases.test.ts
git commit -m "test(evals): four browsing tasks graded from the sites data"
```

---

### Task 6: Install the sites in a real computer

**Files:**
- Create: `packages/testkit/src/evals/browsing/install.ts`
- Test: `packages/testkit/src/evals/browsing/install.test.ts`

**Interfaces:**
- Consumes:
  - `executeChecked`, `startFixtureServer` (Task 1);
  - `scriptedComputer` (Task 1, tests);
  - `SITES_PATH`, `SITE_SERVER_PATH`, `SITE_PORT`, `SITE_URL`, `parseSiteRequests`, `SiteRequest` (Task 3);
  - `ComputerFixture`, `EvalApp` (Task 4);
  - `toComputerRef` from `@rakazo/adapters`.
- Produces:
  - `SITES_DIR = "/tmp/rakazo-sites"`;
  - `installBrowsingSites(sandbox, computer, context): Promise<void>`;
  - `readSiteRequests(sandbox, computer, context): Promise<SiteRequest[]>`;
  - `browsingComputerFixture(sandbox: SandboxProvider): ComputerFixture`.

- [ ] **Step 1: Write the failing tests**

`packages/testkit/src/evals/browsing/install.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptedComputer } from "../../scripted-sandbox.js";
import { installBrowsingSites, readSiteRequests, SITES_DIR } from "./install.js";
import { SITE_SERVER_PATH, SITES_PATH } from "./sites.js";

describe("installBrowsingSites", () => {
  it("moves the site out of the home before starting it on the benchmark port", async () => {
    const { sandbox, computer, context, text } = await scriptedComputer(() => ({ code: 0 }));
    await installBrowsingSites(sandbox, computer, context);
    expect(await text("rakazo-site-server.py")).toBe(readFileSync(SITE_SERVER_PATH, "utf8"));
    expect(await text("rakazo-sites.json")).toBe(readFileSync(SITES_PATH, "utf8"));
    const start = sandbox.commands[0]!;
    expect(start).toContain(`mv rakazo-site-server.py ${SITES_DIR}/site_server.py`);
    expect(start).toContain(`mv rakazo-sites.json ${SITES_DIR}/sites.json`);
    expect(start.lastIndexOf("mv ")).toBeLessThan(start.indexOf("python3"));
    expect(start).toContain(
      `${SITES_DIR}/site_server.py ${SITES_DIR}/sites.json 8800 ${SITES_DIR}/requests.jsonl`,
    );
    expect(sandbox.commands[1]).toContain("http://127.0.0.1:8800/health");
  });
});

describe("readSiteRequests", () => {
  it("reads the request log from outside the home", async () => {
    const line = JSON.stringify({
      method: "GET",
      path: "/shop",
      query: {},
      fields: {},
      userAgent: "Chrome",
    });
    const { sandbox, computer, context } = await scriptedComputer(() => ({
      code: 0,
      stdout: `${line}\n${line}\n`,
    }));
    expect(await readSiteRequests(sandbox, computer, context)).toHaveLength(2);
    expect(sandbox.commands[0]).toContain(`${SITES_DIR}/requests.jsonl`);
  });

  it("has no requests when nothing reached the site", async () => {
    const { sandbox, computer, context } = await scriptedComputer(() => ({ code: 0, stdout: "" }));
    expect(await readSiteRequests(sandbox, computer, context)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/evals/browsing/install.test.ts`
Expected: FAIL, because `./install.js` does not exist.

- [ ] **Step 3: Write the installer**

`packages/testkit/src/evals/browsing/install.ts`:

```ts
import { readFileSync } from "node:fs";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import { executeChecked, startFixtureServer } from "../../computer-fixture-server.js";
import type { ComputerFixture, EvalApp } from "../runner.js";
import type { SiteRequest } from "./sites.js";
import { parseSiteRequests, SITE_PORT, SITE_SERVER_PATH, SITE_URL, SITES_PATH } from "./sites.js";

/** Outside the bot's home, so read_file and write_file cannot reach the data or the log. */
export const SITES_DIR = "/tmp/rakazo-sites";
const SERVER_FILE = "rakazo-site-server.py";
const DATA_FILE = "rakazo-sites.json";

export async function installBrowsingSites(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  await startFixtureServer(sandbox, computer, context, {
    // The sandbox writes into the home; the start command moves both files out before anything runs.
    files: {
      [SERVER_FILE]: readFileSync(SITE_SERVER_PATH, "utf8"),
      [DATA_FILE]: readFileSync(SITES_PATH, "utf8"),
    },
    command: [
      `mkdir -p ${SITES_DIR}`,
      `mv ${SERVER_FILE} ${SITES_DIR}/site_server.py`,
      `mv ${DATA_FILE} ${SITES_DIR}/sites.json`,
      `setsid -f python3 ${SITES_DIR}/site_server.py ${SITES_DIR}/sites.json ${SITE_PORT} ${SITES_DIR}/requests.jsonl > ${SITES_DIR}/server.log 2>&1 < /dev/null`,
    ].join(" && "),
    readyUrl: `${SITE_URL}/health`,
    logPath: `${SITES_DIR}/server.log`,
  });
}

export async function readSiteRequests(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<SiteRequest[]> {
  return parseSiteRequests(
    await executeChecked(sandbox, computer, context, `cat ${SITES_DIR}/requests.jsonl 2>/dev/null || true`),
  );
}

/** Finds the trial bot's computer (one per trial space), then installs or reads the sites there. */
export function browsingComputerFixture(sandbox: SandboxProvider): ComputerFixture {
  const locate = async (trial: EvalApp, botId: string) => {
    const bot = await trial.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { spaceId: true, userId: true },
    });
    const computer = await trial.prisma.computer.findFirstOrThrow({
      where: { spaceId: bot.spaceId, providerRef: { not: null } },
      select: { homeKey: true, kind: true, providerRef: true },
    });
    return {
      computer: toComputerRef(computer),
      context: {
        operationId: `eval-sites-${botId}`,
        traceId: `eval-sites-${botId}`,
        spaceId: bot.spaceId,
        userId: bot.userId,
        botId,
        signal: AbortSignal.timeout(60_000),
      },
    };
  };
  return {
    install: async (trial, botId) => {
      const { computer, context } = await locate(trial, botId);
      await installBrowsingSites(sandbox, computer, context);
    },
    siteRequests: async (trial, botId) => {
      const { computer, context } = await locate(trial, botId);
      return readSiteRequests(sandbox, computer, context);
    },
  };
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run:
```bash
pnpm exec vitest run packages/testkit/src/evals/browsing/
pnpm --filter @rakazo/testkit check
pnpm exec biome check packages/testkit/src/evals/browsing/
```
Expected: all PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add packages/testkit/src/evals/browsing/install.ts packages/testkit/src/evals/browsing/install.test.ts
git commit -m "test(evals): install the browsing sites outside the bot's home"
```

---

### Task 7: Suite descriptions, CLI wiring and Anthropic pricing

**Files:**
- Create: `packages/testkit/src/evals/suites.ts`
- Test: `packages/testkit/src/evals/suites.test.ts`
- Create: `packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json`
- Modify: `packages/testkit/src/evals/measurement.test.ts` (one fixture-load test)
- Modify: `packages/testkit/src/evals/cli.test.ts` (one `--suite browsing --list` assertion)
- Modify: `packages/testkit/src/cli/evals.ts`:
  - imports at lines 1-20;
  - `parseArgs` defaults at lines 44-45;
  - suites at lines 49-56;
  - controls at lines 70-75;
  - report `fixtures` and `limitations` at lines 129-137;
  - env and app setup at lines 286-460;
  - the `finally` at lines 505-513.

**Interfaces:**
- Consumes:
  - `BROWSING_EVAL_CASES`, `BROWSING_FIXTURE_VERSION` (Task 5);
  - `browsingComputerFixture` (Task 6);
  - `assertComputerImage`, `DEFAULT_COMPUTER_IMAGE`, `dockerComputerEnv`, `serveSupervisor`, `destroyComputers` (Task 2);
  - `TrialOptions.computerFixture` (Task 4).
- Produces:
  - `type EvalSuite`;
  - `EVAL_SUITES`;
  - `resolveSuite(name: string): EvalSuite`;
  - `resolveControls(suite: EvalSuite, flags: { trials: string; timeoutMs?: string; maxToolCalls?: string })`.

- [ ] **Step 1: Write the failing tests**

`packages/testkit/src/evals/suites.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EVAL_SUITES, resolveControls, resolveSuite } from "./suites.js";

// Today's values for the offline suites, copied from cli/evals.ts before this change.
const OFFLINE_FIXTURES = "synthetic services, messaging and fake sandbox";
const OFFLINE_LIMITATIONS = [
  "Does not evaluate browser perception, native recording perception, or real external services.",
  "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
  "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
  "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.",
  "Tool trace contains names and statuses only; raw requests and responses are omitted.",
];

describe("eval suites", () => {
  it("keeps the offline suites exactly as they were", () => {
    for (const name of ["product", "history", "silence"] as const) {
      const suite = EVAL_SUITES[name];
      expect(suite).not.toHaveProperty("computer");
      expect(suite.fixtures).toBe(OFFLINE_FIXTURES);
      expect(suite.limitations).toEqual(OFFLINE_LIMITATIONS);
      expect(resolveControls(suite, { trials: "3" })).toEqual({
        trials: 3,
        timeoutMs: 180_000,
        maxToolCalls: 30,
      });
    }
  });

  it("runs browsing on a real computer with more room per task", () => {
    const suite = resolveSuite("browsing");
    expect(suite.computer).toBe("docker");
    expect(suite.cases.map((c) => c.id)).toEqual([
      "browse-compare-cheapest",
      "browse-form-checkout",
      "browse-extract-csv",
      "browse-hard-page",
    ]);
    expect(resolveControls(suite, { trials: "1" })).toEqual({
      trials: 1,
      timeoutMs: 300_000,
      maxToolCalls: 60,
    });
  });

  it("lets explicit flags override a suite's controls", () => {
    expect(
      resolveControls(resolveSuite("browsing"), { trials: "2", timeoutMs: "1000", maxToolCalls: "5" }),
    ).toEqual({ trials: 2, timeoutMs: 1000, maxToolCalls: 5 });
  });

  it("names every suite when one is unknown", () => {
    expect(() => resolveSuite("nope")).toThrow(
      "Unknown suite; use product, history, silence, browsing",
    );
  });
});
```

Append to `packages/testkit/src/evals/measurement.test.ts`, matching its imports: `readFileSync` from `node:fs` and `validatePricing` from `./measurement.js`.

```ts
it("accepts the checked-in Anthropic pricing, including one-hour cache writes", () => {
  const pricing = validatePricing(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(pricing.cacheWrite1h).toBeGreaterThan(pricing.cacheWrite);
});
```

In `packages/testkit/src/evals/cli.test.ts`, add a second invocation to the existing guard test, inside the same `it` and with the same `guard` and `execFileSync` arguments, plus `"--suite", "browsing"`. Assert that its output contains `browse-hard-page:`. This proves the browsing list loads without the database client or adapters.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/testkit/src/evals/suites.test.ts packages/testkit/src/evals/measurement.test.ts packages/testkit/src/evals/cli.test.ts`
Expected:
- `suites.test.ts` fails because `./suites.js` does not exist;
- the pricing test fails with ENOENT;
- the CLI test fails with "Unknown suite".

- [ ] **Step 3: Write `suites.ts` and the pricing file**

`packages/testkit/src/evals/suites.ts`:

```ts
import { BROWSING_EVAL_CASES, BROWSING_FIXTURE_VERSION } from "./browsing/cases.js";
import type { EvalCase } from "./cases.js";
import { EVAL_CASES, HISTORY_EVAL_CASES } from "./cases.js";
import { HISTORY_FIXTURE_VERSION } from "./history-fixtures.js";
import { SILENCE_EVAL_CASES, SILENCE_FIXTURE_VERSION } from "./silence.js";

export type EvalSuite = {
  cases: EvalCase[];
  fixtureVersion: string;
  /** "docker" runs each trial against a real bot computer instead of the offline eval sandbox. */
  computer?: "docker";
  controls: { timeoutMs: number; maxToolCalls: number };
  fixtures: string;
  limitations: string[];
};

const COST_LIMITATION =
  "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.";
const TRACE_LIMITATION =
  "Tool trace contains names and statuses only; raw requests and responses are omitted.";
const OFFLINE = {
  controls: { timeoutMs: 180_000, maxToolCalls: 30 },
  fixtures: "synthetic services, messaging and fake sandbox",
  limitations: [
    "Does not evaluate browser perception, native recording perception, or real external services.",
    "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
    "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
    COST_LIMITATION,
    TRACE_LIMITATION,
  ],
};

export const EVAL_SUITES = {
  product: { cases: EVAL_CASES, fixtureVersion: "product-v1", ...OFFLINE },
  history: { cases: HISTORY_EVAL_CASES, fixtureVersion: HISTORY_FIXTURE_VERSION, ...OFFLINE },
  silence: { cases: SILENCE_EVAL_CASES, fixtureVersion: SILENCE_FIXTURE_VERSION, ...OFFLINE },
  browsing: {
    cases: BROWSING_EVAL_CASES,
    fixtureVersion: BROWSING_FIXTURE_VERSION,
    computer: "docker",
    controls: { timeoutMs: 300_000, maxToolCalls: 60 },
    fixtures: "synthetic local websites served inside a real Docker bot computer",
    limitations: [
      "Shell, web_fetch and web_search are off for the bot, so this measures the browser path only.",
      "The sites are synthetic and local; real websites are slower and change.",
      "Each run uses one model connection; a few trials give a baseline, not a precise rate.",
      COST_LIMITATION,
      TRACE_LIMITATION,
    ],
  },
} satisfies Record<string, EvalSuite>;

export function resolveSuite(name: string): EvalSuite {
  if (!Object.hasOwn(EVAL_SUITES, name))
    throw new Error(`Unknown suite; use ${Object.keys(EVAL_SUITES).join(", ")}`);
  return EVAL_SUITES[name as keyof typeof EVAL_SUITES];
}

/** Explicit flags win; otherwise each suite's own limits apply. */
export function resolveControls(
  suite: EvalSuite,
  flags: { trials: string; timeoutMs?: string; maxToolCalls?: string },
) {
  return {
    trials: Number(flags.trials),
    timeoutMs: Number(flags.timeoutMs ?? suite.controls.timeoutMs),
    maxToolCalls: Number(flags.maxToolCalls ?? suite.controls.maxToolCalls),
  };
}
```

Check before keeping this: `HISTORY_EVAL_CASES` comes from `./cases.js` and `HISTORY_FIXTURE_VERSION` from `./history-fixtures.js`, exactly as `cli/evals.ts` imports them today (lines 11-12). Copy those import sources verbatim.

`packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json`. These are first-party rates in USD per million tokens for `claude-sonnet-5-5`:
- input $2, output $10, cache read $0.20;
- 5-minute cache write at 1.25× input, 1-hour cache write at 2× input;
- no long-context tier.

Before committing, re-read the live pricing page at https://platform.claude.com/docs/en/about-claude/pricing. If a number differs there, use the live number and say so in the commit message.

```json
{
  "source": "Anthropic Claude API pricing for claude-sonnet-5-5",
  "version": "2026-10-22",
  "input": 2,
  "output": 10,
  "cacheRead": 0.2,
  "cacheWrite": 2.5,
  "cacheWrite1h": 4
}
```

- [ ] **Step 4: Wire the CLI**

In `packages/testkit/src/cli/evals.ts`:

1. **Imports.**
   - Remove the `EVAL_CASES, HISTORY_EVAL_CASES`, `HISTORY_FIXTURE_VERSION` and `SILENCE_EVAL_CASES, SILENCE_FIXTURE_VERSION` imports. Keep any other names those lines import if they're still used elsewhere in the file; check with grep.
   - Add these imports:
     - `import { resolveControls, resolveSuite } from "../evals/suites.js";`
     - `import { assertComputerImage, DEFAULT_COMPUTER_IMAGE, destroyComputers, dockerComputerEnv, serveSupervisor } from "../docker-computers.js";`
     - `import type { SandboxProvider } from "@rakazo/adapter-kit";`

     `docker-computers.ts` statically imports only `node:*`, `@hono/node-server` and erased types (`@rakazo/db` is `import type`), and loads `@rakazo/adapters` only inside `destroyComputers`. So the `--list` guard still holds.
2. **Flag defaults.** In `parseArgs`, delete `default: "180000"` from `"timeout-ms"` and `default: "30"` from `"max-tool-calls"`.
3. **Suite lookup.** Replace the `const suites = {...}`, the `Object.hasOwn` check and the destructuring with:
   ```ts
   const suite = resolveSuite(values.suite!);
   const { cases, fixtureVersion } = suite;
   ```
4. **Controls.** Replace the `controls` object literal with:
   ```ts
   const controls = resolveControls(suite, {
     trials: values.trials!,
     timeoutMs: values["timeout-ms"],
     maxToolCalls: values["max-tool-calls"],
   });
   ```
5. **Report text.** Set `fixtures: suite.fixtures,` and `limitations: suite.limitations,`.
6. **Image check.** Right before `postgres = await new PostgreSqlContainer(...)`, add `if (suite.computer === "docker") assertComputerImage(DEFAULT_COMPUTER_IMAGE);`.
7. **Docker setup.** After the existing `const { EvalSandboxProvider } = await import("../evals/sandbox.js");` line:
   - add `DockerSandboxProvider` to the existing `await import("@rakazo/adapters")` destructuring;
   - then add the block below.

   Declare `let docker: { url: string; sandbox: SandboxProvider; close(): Promise<void> } | undefined;` before the `try`, next to `postgres`, so the `finally` can close it. Assign it inside:

```ts
    const { browsingComputerFixture } = await import("../evals/browsing/install.js");
    if (suite.computer === "docker") {
      Object.assign(process.env, dockerComputerEnv(dataDir, DEFAULT_COMPUTER_IMAGE));
      // A root supervisor runs computers as uid 1000 and never changes ownership itself. Keep the
      // homes this disposable run creates writable by that user.
      if (process.getuid?.() === 0) process.umask(0);
      const supervisor = await serveSupervisor();
      docker = {
        url: supervisor.url,
        sandbox: new DockerSandboxProvider(supervisor.url, process.env.SANDBOX_SUPERVISOR_TOKEN!),
        close: supervisor.close,
      };
    }
```

8. **Per-trial sandbox.** In `createApp: async (...) => {`, replace `const sandbox = new EvalSandboxProvider();` with:

```ts
            const evalSandbox = docker ? undefined : new EvalSandboxProvider();
            const sandbox = docker?.sandbox ?? evalSandbox!;
```

   and in the `createApp({...})` arguments:
   - `sandboxProvider: docker ? "docker" : "fake",`;
   - `dataDir: docker ? dataDir : path.join(dataDir, `${scenario.id}-${planned.strategy}-${planned.trial}`),`, because the supervisor accepts homes only under its own `DATA_DIR`;
   - `...(docker ? { sandboxSupervisorUrl: docker.url } : {}),`. Keep this only if `AppEnv` has `sandboxSupervisorUrl`; check `apps/api/src/env.ts`.
9. **Trial handles.** In the returned object:
   - `harnessIssues: evalSandbox?.harnessIssues ?? [],`;
   - replace `stop` with:

```ts
              stop: async () => {
                acceptingCalls = false;
                try {
                  if (docker) await destroyComputers(handles.prisma, docker.sandbox);
                } finally {
                  await handles.stop();
                }
              },
```

10. **Fixture hook.** In the `runTrial(scenario, planned.trial, {...})` options, add `...(docker ? { computerFixture: browsingComputerFixture(docker.sandbox) } : {}),`. The CLI picks the fixture, not `suites.ts`, because `install.ts` imports `@rakazo/adapters` and `suites.ts` must stay light enough for `--list`. Browsing is Phase 1's only Docker suite. If a second one ever exists, give `EvalSuite` a fixture name and keep the lookup in the CLI.
11. **Shutdown.** In the outer `finally`, before `await postgres?.stop();`, add `await docker?.close().catch(() => undefined);`.

- [ ] **Step 5: Run the tests, typecheck and lint**

Run:
```bash
pnpm exec vitest run packages/testkit/src/evals/
pnpm --filter @rakazo/testkit check
pnpm exec biome check packages/testkit/src/evals/suites.ts packages/testkit/src/evals/suites.test.ts packages/testkit/src/evals/measurement.test.ts packages/testkit/src/evals/cli.test.ts packages/testkit/src/cli/evals.ts packages/testkit/src/evals/fixtures/
pnpm test:evals --list --suite browsing
```
Expected:
- **Tests:** all pass, including the existing eval suites.
- **tsc and Biome:** clean.
- **`--list`:** prints the four `browse-*` ids with their purposes.

- [ ] **Step 6: Commit**

```bash
git add packages/testkit/src/evals/suites.ts packages/testkit/src/evals/suites.test.ts packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json packages/testkit/src/evals/measurement.test.ts packages/testkit/src/evals/cli.test.ts packages/testkit/src/cli/evals.ts
git commit -m "test(evals): browsing suite on real Docker computers"
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/agent-verification.md` (layer table at lines 10-18, and a new section after "Real-model quality")

- [ ] **Step 1: Add the table row**

After the `| Agent quality | ... |` row, add:

```markdown
| Browsing benchmark | Product API, Postgres, executor, Pi, real model, Docker computer, Chromium | Synthetic local sites | `pnpm test:evals --live --suite browsing ...` |
```

- [ ] **Step 2: Add the section** (place it right before `### Routine silence evals`)

````markdown
### Browsing benchmark

The `browsing` suite measures how fast and how reliably a bot gets browsing work done. Each
trial runs the real product against a real Docker computer, with Chromium visiting synthetic
sites served inside that computer. The four tasks cover the core browsing jobs:

- comparing items across search, filters and pages;
- a two-step checkout placed exactly once;
- extracting a table into a CSV;
- a page that hides its content behind a cookie banner, a long scroll and a late load.

Build the computer image first (`pnpm sandbox:build`), then run:

```bash
pnpm test:evals --live --suite browsing --provider anthropic --model claude-sonnet-5-5 \
  --api-key-env ANTHROPIC_API_KEY \
  --pricing packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json \
  --trials 3 --spend-cap-usd 5 --output test-report/evals/browsing.json
```

**Reading the report.** Each trial's `timings.taskMs` is the time its runs actually spent
running, taken from the product's own run records. It excludes app startup, account setup
(`setupMs`) and computer boot (`bootMs`). Each summary row gives `taskMsP50` and `taskMsP95` per
task. Compare these, together with the success rate, tool calls and cost, before and after a
browsing change.

**Grading** uses the site's own request log and the files the bot wrote, never the model's
claims:

- every task requires requests from the computer's Chrome;
- the checkout must be submitted exactly once;
- every expected answer is computed from `sites.json`.

**What this does not measure:**

- **Only the browser path.** The bot's `shell`, `web_fetch` and `web_search` tools are off, so
  the browser is its only route to the sites.
- **Synthetic sites.** They are local; real websites are slower and change.
- **One model per run.** Three trials per task give a baseline, not a precise rate.

**Housekeeping.**

- **Cleanup:** each trial destroys its computer. If the process is killed hard, list leftovers
  with `docker ps --filter label=rakazo.managed` and remove them by name.
- **Data folder:** the run's data lives under the OS temp directory. If that is a small RAM
  disk, point `TMPDIR` at a disk folder first.
````

- [ ] **Step 3: Commit**

```bash
git add docs/agent-verification.md
git commit -m "docs: how to run and read the browsing benchmark"
```

---

### Final verification (controller, after the final review)

These steps are run by the controller, not a subagent. They need Docker, the image, and the user's `ANTHROPIC_API_KEY` from `.env`.

- [ ] **Full offline suite:** run `pnpm test` and save the output to a file. Expected: no new failures compared with `main`.
- [ ] **Wiring check, one live case, about $0.10:**

```bash
TMPDIR=<a disk folder> pnpm test:evals --live --suite browsing --case browse-hard-page --trials 1 \
  --provider anthropic --model claude-sonnet-5-5 --api-key-env ANTHROPIC_API_KEY \
  --pricing packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-2026-10-22.json \
  --spend-cap-usd 1 --output test-report/evals/browsing-wiring.json
```

Expected: the trial passes or fails on agent criteria, with `timings.bootMs` and `timings.taskMs` set. Afterwards `docker ps --filter label=rakazo.managed` shows no new container. A harness failure here means the wiring is wrong: debug it before anything else.

- [ ] **Optional baseline:** run the full suite with `--trials 3 --spend-cap-usd 5`, but only with the user's go-ahead.
