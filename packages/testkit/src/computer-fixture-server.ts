import assert from "node:assert/strict";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";

/**
 * A local website a test runs inside a bot's computer. `command`, `readyUrl` and `logPath` go into
 * bash unescaped, so they must be trusted constants.
 */
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
