// @vitest-environment jsdom

import type { ActionOfferCard } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ take: vi.fn(), dismiss: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { actionOffers: api } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: unknown }) => children };
});

import { OfferCard } from "./message-cards";

const card: ActionOfferCard = {
  id: "offer-1",
  kind: "task",
  label: "Book the hotel",
  task: "Book the Lisbon hotel we compared.",
  expiresAt: "2026-10-24T10:00:00.000Z",
  status: "open",
};
const now = new Date("2026-10-21T10:00:00.000Z");
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.take.mockReset().mockResolvedValue({ runId: "run-2" });
  api.dismiss.mockReset().mockResolvedValue({ status: "dismissed" });
});
afterEach(() => container?.remove());

function render(next: ActionOfferCard, onJump = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  act(() =>
    createRoot(container).render(<OfferCard card={next} now={now} onJumpToMessage={onJump} />),
  );
  return onJump;
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );

it("shows the full task, takes the card, and shows it done at once", async () => {
  render(card);
  expect(container.textContent).toContain("Book the Lisbon hotel we compared.");
  await act(async () => button("Book the hotel")!.click());
  expect(api.take).toHaveBeenCalledWith({ offerId: "offer-1" });
  expect(container.querySelector('[data-offer-status="taken"]')).not.toBeNull();
});

it("dismisses with an always-visible control", async () => {
  render(card);
  const dismiss = button("Dismiss")!;
  expect(dismiss.className).not.toContain("opacity-0");
  await act(async () => dismiss.click());
  expect(api.dismiss).toHaveBeenCalledWith({ offerId: "offer-1" });
  expect(container.querySelector('[data-offer-status="dismissed"]')).not.toBeNull();
});

it("shows a closed card quietly and explains a waiting bot in the user's language", async () => {
  api.take.mockRejectedValueOnce(
    Object.assign(new Error("x"), {
      code: "CONFLICT",
      data: { reason: "card_closed", status: "taken" },
    }),
  );
  render(card);
  await act(async () => button("Book the hotel")!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-offer-status="taken"]')).not.toBeNull();
  container.remove();
  api.take.mockRejectedValueOnce(
    Object.assign(new Error("x"), {
      code: "CONFLICT",
      data: { reason: "waiting_for_answer", botName: "Ada" },
    }),
  );
  render(card);
  await act(async () => button("Book the hotel")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Answer Ada's question first.",
  );
});

it("labels a save-skill card in the user's language, and links a taken card to its message", async () => {
  render({ ...card, kind: "save_skill", label: "Save as a skill" });
  expect(button("Save as a skill")).toBeDefined();
  container.remove();
  const onJump = render({ ...card, status: "taken", takenMessageId: "msg-9" });
  await act(async () => button("Book the hotel")!.click());
  expect(onJump).toHaveBeenCalledWith("msg-9");
  expect(api.take).not.toHaveBeenCalled();
});

it("mutes an expired card", () => {
  render({ ...card, expiresAt: "2026-10-20T10:00:00.000Z" });
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).toBe("Book the hotel");
});
