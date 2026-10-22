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
