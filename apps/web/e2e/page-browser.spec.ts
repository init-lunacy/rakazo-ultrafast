import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-page-browser",
);

test("live page helper preserves identity, masks passwords, and reports partial actions", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/popup")) {
      res.end(
        `<!doctype html><title>Popup source</title><a href="/opened" target="_blank">Open</a>`,
      );
      return;
    }
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <script>window.__rakazoPageBrowser={snapshot:()=>({title:'spoofed'})};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
      // Popups must open only because an agent's click is a user gesture.
      ignoreDefaultArgs: ["--disable-popup-blocking"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);
    // Only the decider's extended snapshot carries rects, and its capture is the
    // viewport those rects are measured in.
    const extended = await command("snapshot", { extended: true });
    const box = extended.elements.find((element: { name: string }) => element.name === "Name").rect;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const capture = await command("screenshot");
    expect(capture).toMatchObject({ ok: true, scale: expect.any(Number) });
    expect(Buffer.from(capture.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const snapshot = await command("snapshot");
    expect(snapshot.elements.some((element: { rect?: unknown }) => element.rect)).toBe(false);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.title).toBe("Fixture");
    expect(snapshot.tree).toContain("Readable article content");
    expect(JSON.stringify(snapshot)).not.toContain("fake-test-password");
    const ref = (snapshot: { elements: { name: string; ref: string }[] }, name: string) =>
      snapshot.elements.find((element) => element.name === name)!.ref;
    const result = await command("act", {
      actions: [
        { kind: "fill", ref: ref(snapshot, "Name"), text: "Example" },
        { kind: "click", ref: ref(snapshot, "Save") },
        { kind: "click", ref: "missing-ref" },
      ],
    });
    expect(result).toMatchObject({ ok: false, completed: 2, uncertain: false });
    await expect(page.locator("#name")).toHaveValue("Example");
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    const stale = await command("snapshot");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML = '<button id="save">Replacement</button>';
    });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(stale, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    const refreshed = await command("snapshot");
    expect(ref(refreshed, "Replacement")).not.toBe(ref(stale, "Save"));
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(
      await command("navigate", { url: `http://127.0.0.1:${address.port}/next` }),
    ).toMatchObject({ ok: true, title: "Fixture" });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Replacement") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(await command("navigate", { url: "file:///tmp/fixture" })).toMatchObject({ ok: false });
    await page.route("http://insecure.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Insecure fixture</title><button>HTTP action</button>",
      }),
    );
    await page.goto("http://insecure.test/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Insecure fixture" });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const other = await context.newPage();
    await other.setContent("<title>Other tab</title><button>Other action</button>");
    await page.bringToFront();
    // Headless Chromium marks both pages visible/focused. Ambiguity must fail safely.
    expect(await command("snapshot")).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringContaining("unambiguous"),
    });
    await expect(page).toHaveTitle("Fixture");
    await expect(other).toHaveTitle("Other tab");
    // Reading an existing page neither creates nor switches tabs.
    expect(context.pages()).toHaveLength(2);

    // Tabs: addressed commands run in their own tab, whichever tab is in front.
    const listed = await command("tabs");
    expect(listed.ok).toBe(true);
    // An unnamed command runs in the focused tab and says which one it was.
    const first = snapshot.target as string;
    expect(listed.tabs.map((tab: { target: string }) => tab.target)).toContain(first);
    const opened = await command("open", { url: `http://127.0.0.1:${address.port}/popup` });
    expect(opened).toMatchObject({ ok: true, title: "Popup source", target: expect.any(String) });
    expect(opened.target).not.toBe(first);
    const source = await command("snapshot", { target: opened.target });
    expect(source).toMatchObject({ ok: true, target: opened.target, title: "Popup source" });
    const back = await command("snapshot", { target: first });
    expect(back).toMatchObject({ ok: true, target: first, title: "Fixture" });
    // Another agent reading the tab leaves the refs its owner holds working.
    await command("snapshot", { target: first });
    expect(
      await command("act", {
        target: first,
        actions: [{ kind: "click", ref: ref(back, "Agree") }],
      }),
    ).toMatchObject({ ok: true, completed: 1 });

    // A click that opens a tab reports it, attributed to the tab that opened it.
    const link = source.elements.find((element: { name: string }) => element.name === "Open");
    const clicked = await command("act", {
      target: opened.target,
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(clicked).toMatchObject({ ok: true, target: opened.target });
    await expect(async () => {
      const after = (await command("tabs")).tabs as Array<{ target: string; openerId?: string }>;
      expect(after.some((tab) => tab.openerId === opened.target)).toBe(true);
    }).toPass({ timeout: 5_000 });

    // Follow brings a tab to the front; a closed tab is refused, never replaced.
    expect(await command("activate", { target: opened.target })).toMatchObject({
      ok: true,
      front: opened.target,
    });
    expect(await command("close", { target: opened.target })).toMatchObject({ ok: true });
    expect(await command("snapshot", { target: opened.target })).toMatchObject({
      ok: false,
      error: "That tab is closed.",
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
