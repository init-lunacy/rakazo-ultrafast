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
    // The server holds the data in memory; nothing on disk gives the answers away.
    expect(sandbox.commands[2]).toBe(`rm ${SITES_DIR}/site_server.py ${SITES_DIR}/sites.json`);
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

  it("fails when the request log is missing", async () => {
    const { sandbox, computer, context } = await scriptedComputer(() => ({
      code: 1,
      stderr: "No such file or directory",
    }));
    await expect(readSiteRequests(sandbox, computer, context)).rejects.toThrow(/No such file/);
    // No fallback in the command: a missing log is a broken harness, not an idle bot.
    expect(sandbox.commands[0]).toBe(`cat ${SITES_DIR}/requests.jsonl`);
  });

  it("has no requests when nothing reached the site", async () => {
    const { sandbox, computer, context } = await scriptedComputer(() => ({ code: 0, stdout: "" }));
    expect(await readSiteRequests(sandbox, computer, context)).toEqual([]);
  });
});
