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
  const { supervisorApp } = await import("../../../../infra/sandboxes/supervisor/src/index.js");
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
