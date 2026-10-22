import type { Criterion, EvalCase, Evidence } from "../cases.js";
import { check } from "../cases.js";
import type { BrowsingSites, Product } from "./sites.js";
import { formatPrice, loadSites, SITE_URL } from "./sites.js";

const SITES = loadSites();
export const BROWSING_FIXTURE_VERSION = SITES.version;

/**
 * The shell, app launching and server-side web tools are off, so the sites are reached through the
 * browser. The desktop stays reachable through computer_act; graders check the requests came from
 * Chrome.
 */
const BROWSER_ONLY = {
  connections: [] as string[],
  disabledBuiltinTools: ["shell", "launch_app", "web_fetch", "web_search"],
};

export const CHECKOUT_ORDER = {
  item: "trail-thermos-750",
  quantity: "2",
  shipping: "standard",
  name: "Sam Example",
  street: "1 Test Street",
  city: "Testville",
  postcode: "00000",
};
export const BOOT_COLUMNS = ["name", "weight", "waterproof", "drop"] as const;

export const qualifiesAsJacket = (product: Product) =>
  product.category === "jackets" &&
  product.waterproof &&
  product.inStock &&
  product.sizes.includes("M");

export function cheapestJacket(sites: BrowsingSites): Product {
  const [cheapest] = sites.shop.products
    .filter(qualifiesAsJacket)
    .sort((a, b) => a.price - b.price);
  if (!cheapest) throw new Error("sites.json has no qualifying jacket");
  return cheapest;
}

export function hikingBootRows(sites: BrowsingSites): string[][] {
  return sites.shop.products
    .filter((product) => product.name.includes("Hiking Boot"))
    .map((product) => [
      product.name,
      product.specs.weight ?? "",
      product.waterproof ? "Yes" : "No",
      product.specs.drop ?? "",
    ]);
}

export function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) =>
      line.split(",").map((cell) =>
        cell
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .trim(),
      ),
    );
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const rowKey = (row: readonly string[]) => row.map(normalize).join("|");
const file = (evidence: Evidence, name: string) => evidence.files[name]?.trim() ?? "";
const requestsTo = (evidence: Evidence, prefix: string) =>
  (evidence.siteRequests ?? []).filter((request) => request.path.startsWith(prefix));

/** The task reached the site, only through the computer's Chrome. */
function usedBrowser(evidence: Evidence, prefix: string): Criterion {
  const requests = requestsTo(evidence, prefix);
  return check(
    "used-browser",
    evidence.toolNames.some(
      (name) => name.startsWith("browser_") || name.startsWith("computer_"),
    ) &&
      requests.length > 0 &&
      requests.every((request) => request.userAgent.includes("Chrome")),
  );
}

export const BROWSING_EVAL_CASES: EvalCase[] = [
  {
    id: "browse-compare-cheapest",
    purpose:
      "Search, filter and page through a shop for the cheapest item meeting three conditions.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, find the cheapest jacket that is waterproof, in stock and available in size M. Write it to results/cheapest.md as "<name> — <price>", for example "Example Jacket — $10.00".`,
      },
    ],
    files: ["results/cheapest.md"],
    grade: (evidence) => {
      const answer = cheapestJacket(SITES);
      const text = normalize(file(evidence, "results/cheapest.md"));
      return [
        check(
          "cheapest-jacket",
          text.includes(normalize(answer.name)) &&
            text.includes(formatPrice(answer)) &&
            SITES.shop.products.every(
              (product) => product === answer || !text.includes(normalize(product.name)),
            ),
        ),
        usedBrowser(evidence, "/shop"),
      ];
    },
  },
  {
    id: "browse-form-checkout",
    purpose: "Complete a two-step checkout exactly once and report the order number.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, buy the Trail Thermos 750: quantity ${CHECKOUT_ORDER.quantity}, ${CHECKOUT_ORDER.shipping} shipping, for ${CHECKOUT_ORDER.name}, ${CHECKOUT_ORDER.street}, ${CHECKOUT_ORDER.city}, postcode ${CHECKOUT_ORDER.postcode}. Place the order once, then tell me the order number.`,
      },
    ],
    grade: (evidence) => {
      const orders = requestsTo(evidence, "/checkout/confirm").filter(
        (request) => request.orderNumber,
      );
      const [order] = orders;
      return [
        check("one-order", orders.length === 1),
        check(
          "order-details",
          !!order &&
            Object.entries(CHECKOUT_ORDER).every(
              ([name, value]) => normalize(order.fields[name] ?? "") === normalize(value),
            ),
        ),
        check(
          "order-number-reported",
          !!order?.orderNumber && evidence.text.includes(order.orderNumber),
        ),
        usedBrowser(evidence, "/checkout"),
      ];
    },
  },
  {
    id: "browse-extract-csv",
    purpose: "Collect a specs table from several product pages into an exact CSV.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `In the shop at ${SITE_URL}/shop, find the three hiking boots and save their specs to results/boots.csv with the header ${BOOT_COLUMNS.join(",")} and one row per boot. Use the values exactly as the product pages show them; waterproof is Yes or No.`,
      },
    ],
    files: ["results/boots.csv"],
    grade: (evidence) => {
      const [header = [], ...rows] = parseCsv(file(evidence, "results/boots.csv"));
      const expected = hikingBootRows(SITES).map(rowKey);
      const found = new Set(rows.map(rowKey));
      return [
        check("csv-header", rowKey(header) === rowKey(BOOT_COLUMNS)),
        check(
          "csv-rows",
          rows.length === expected.length && expected.every((row) => found.has(row)),
        ),
        usedBrowser(evidence, "/shop"),
      ];
    },
  },
  {
    id: "browse-hard-page",
    purpose: "Get past a cookie banner, a long page and a late-loading section to one fact.",
    ...BROWSER_ONLY,
    steps: [
      {
        ask: `Read the article at ${SITE_URL}/article. In what year was the trail first mapped? Save just the year to results/fact.txt.`,
      },
    ],
    files: ["results/fact.txt"],
    grade: (evidence) => [
      check("fact-year", file(evidence, "results/fact.txt") === SITES.article.factYear),
      check("late-section-loaded", requestsTo(evidence, "/article/late").length > 0),
      usedBrowser(evidence, "/article"),
    ],
  },
];
