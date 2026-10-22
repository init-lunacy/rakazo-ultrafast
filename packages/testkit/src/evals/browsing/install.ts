import { readFileSync } from "node:fs";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import { executeChecked, startFixtureServer } from "../../computer-fixture-server.js";
import type { ComputerFixture, EvalApp } from "../runner.js";
import type { SiteRequest } from "./sites.js";
import { parseSiteRequests, SITE_PORT, SITE_SERVER_PATH, SITE_URL, SITES_PATH } from "./sites.js";

/**
 * Outside the bot's home, so read_file and write_file cannot reach it. The desktop can (a terminal
 * runs as the same user), so the data files are deleted once the server has loaded them.
 */
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
  await executeChecked(
    sandbox,
    computer,
    context,
    `rm ${SITES_DIR}/site_server.py ${SITES_DIR}/sites.json`,
  );
}

export async function readSiteRequests(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<SiteRequest[]> {
  return parseSiteRequests(
    await executeChecked(sandbox, computer, context, `cat ${SITES_DIR}/requests.jsonl`),
  );
}

/** Finds the trial bot's own computer, then installs or reads the sites there. */
export function browsingComputerFixture(sandbox: SandboxProvider): ComputerFixture {
  const locate = async (trial: EvalApp, botId: string) => {
    const bot = await trial.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: {
        spaceId: true,
        userId: true,
        computer: { select: { homeKey: true, kind: true, providerRef: true } },
      },
    });
    if (!bot.computer) throw new Error("The trial bot has no computer");
    return {
      computer: toComputerRef(bot.computer),
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
