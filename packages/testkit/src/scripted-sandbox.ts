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
