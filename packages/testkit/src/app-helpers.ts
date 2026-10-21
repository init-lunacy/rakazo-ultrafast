import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

export type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

let botIntroHarness: BotIntroHarness | undefined;

export function setBotIntroHarness(harness: BotIntroHarness) {
  botIntroHarness = harness;
}

export function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

export async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

export async function raw(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

export async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, procedure, payload.json as T);
}

export interface Bot {
  id: string;
}
