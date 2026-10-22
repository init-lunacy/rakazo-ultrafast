import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SITES_PATH = fileURLToPath(new URL("./sites.json", import.meta.url));
export const SITE_SERVER_PATH = fileURLToPath(new URL("./site_server.py", import.meta.url));
export const SITE_PORT = 8800;
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;

export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  waterproof: boolean;
  sizes: string[];
  inStock: boolean;
  specs: Record<string, string>;
};
type Section = { heading: string; text: string };
export type BrowsingSites = {
  version: string;
  shop: { pageSize: number; products: Product[] };
  checkout: { shipping: string[] };
  article: {
    title: string;
    sections: Section[];
    lateSection: Section;
    factYear: string;
    lateDelayMs: number;
  };
};
/** One line of the site server's request log. */
export type SiteRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  fields: Record<string, string>;
  userAgent: string;
  orderNumber?: string;
};

export function loadSites(): BrowsingSites {
  return JSON.parse(readFileSync(SITES_PATH, "utf8")) as BrowsingSites;
}

/** The shop's price format; site_server.py renders the same. */
export function formatPrice(product: Product) {
  return `$${product.price.toFixed(2)}`;
}

export function parseSiteRequests(text: string): SiteRequest[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SiteRequest);
}
