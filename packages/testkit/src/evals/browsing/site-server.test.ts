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
afterAll(() => server?.close());

describe("site server", () => {
  it("creates its request log before the first request", () => {
    expect(server.requests()).toEqual([]);
  });

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
    expect(
      server
        .requests()
        .slice(before)
        .every((r) => !r.orderNumber),
    ).toBe(true);
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
