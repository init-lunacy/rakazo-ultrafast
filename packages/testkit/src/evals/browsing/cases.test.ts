import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import {
  BOOT_COLUMNS,
  BROWSER_ONLY_TOOLS,
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
      .grade({
        text: "",
        files: {},
        toolNames: ["browser_navigate"],
        siteRequests: [],
        ...evidence,
      } as Evidence)
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
  afterAll(() => server?.close());
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

  it("puts the late section past the text a page snapshot returns", async () => {
    // rakazo-page-browser's snapshot keeps the first 12,000 characters of the page's text.
    const html = await page("/article");
    // Once the banner is accepted only the article remains, so count from <main>.
    const before = html
      .slice(html.indexOf("<main"), html.indexOf("<div id='late'>"))
      .replace(/<[^>]*>/g, "");
    expect(before.length).toBeGreaterThan(12_000);
  });

  it("puts the article's year only in the late section", () => {
    const { article } = sites;
    const elsewhere = [article.title, ...article.sections.map((s) => s.text)].join(" ");
    expect(article.lateSection.text).toContain(article.factYear);
    expect(elsewhere).not.toContain(article.factYear);
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

  it("fails a hedged answer that also names another jacket", () => {
    const moss = sites.shop.products.find((p) => p.id === "moss-waxed-jacket")!;
    expect(
      grade("browse-compare-cheapest", {
        files: { "results/cheapest.md": `${cheapest}\n${moss.name} — ${formatPrice(moss)}` },
        siteRequests: [request("/shop")],
      })["cheapest-jacket"],
    ).toBe(false);
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

  it("runs every task under the same browser-only policy", () => {
    for (const scenario of BROWSING_EVAL_CASES)
      expect(scenario).toMatchObject({ connections: [], disabledBuiltinTools: BROWSER_ONLY_TOOLS });
  });
});
