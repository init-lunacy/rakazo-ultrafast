import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { FakeSandboxProvider, toComputerRef } from "@rakazo/adapters";
import type { EvalApp } from "./runner.js";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const issue = "Shell execution is unavailable in this offline eval sandbox.";
      if (!this.harnessIssues.includes(issue)) this.harnessIssues.push(issue);
      yield { type: "stderr", data: issue };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}

/** Destroys every provisioned computer in this database; destroying a removed one is a no-op. */
export async function destroyComputers(
  prisma: Pick<EvalApp["prisma"], "computer">,
  sandbox: SandboxProvider,
) {
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
