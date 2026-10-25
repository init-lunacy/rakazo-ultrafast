// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());

vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  function MockView(props: { children?: ReactNode; testID?: string }) {
    return createElement("div", { "data-testid": props.testID }, props.children);
  }

  function MockText(props: { children?: ReactNode; accessibilityRole?: string }) {
    return createElement("span", { role: props.accessibilityRole }, props.children);
  }

  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean };
    testID?: string;
  }) {
    const disabled = Boolean(props.disabled || props.accessibilityState?.disabled);
    return createElement(
      "button",
      {
        type: "button",
        disabled,
        "aria-label": props.accessibilityLabel,
        "aria-selected": props.accessibilityState?.selected ? "true" : "false",
        "data-testid": props.testID,
        onClick: () => {
          if (!disabled) props.onPress?.();
        },
      },
      props.children,
    );
  }

  return {
    ActivityIndicator: () => null,
    Alert: { alert },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable: MockPressable,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: MockText,
    View: MockView,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 1, fontScale: 1 }),
  };
});

vi.mock("./api", () => ({ rpc }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    onPressAction,
  }: {
    children: ReactNode;
    onPressAction: (e: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      <button
        type="button"
        aria-label="menu:dismiss"
        onClick={() => onPressAction({ nativeEvent: { event: "dismiss" } })}
      />
    </div>
  ),
}));

vi.mock("./native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
    mutedForeground: "muted",
  }),
}));

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));

import type { ActionOfferCard } from "@rakazo/contracts";
import { OfferCard } from "../components/OfferCard";

const card: ActionOfferCard = {
  id: "offer-1",
  kind: "task",
  label: "Book the hotel",
  task: "Book the Lisbon hotel we compared.",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "open",
};

describe("OfferCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    rpc.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function renderOffer(next: ActionOfferCard, onOpenMessage = vi.fn()) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<OfferCard card={next} onOpenMessage={onOpenMessage} />);
    });
    const view = container;
    const press = async (name: string) => {
      const target = [...view.querySelectorAll("button")].find(
        (b) => b.textContent === name || b.getAttribute("aria-label") === name,
      );
      if (!target) throw new Error(`missing button ${name}`);
      await act(async () => {
        target.click();
        await Promise.resolve();
      });
    };
    return { container: view, press, onOpenMessage };
  }

  it("takes the card on press, shows its task, and shows it done at once", async () => {
    rpc.mockResolvedValue({ runId: "run-2" });
    const { container: view, press } = renderOffer(card);
    expect(view.textContent).toContain("Book the Lisbon hotel we compared.");
    await press("Book the hotel");
    expect(rpc).toHaveBeenCalledWith("actionOffers/take", { offerId: "offer-1" });
    expect(view.textContent).not.toContain("Book the Lisbon hotel we compared.");
  });

  it("dismisses from the card's menu", async () => {
    rpc.mockResolvedValue({ status: "dismissed" });
    const { container: view, press } = renderOffer(card);
    await press("menu:dismiss");
    expect(rpc).toHaveBeenCalledWith("actionOffers/dismiss", { offerId: "offer-1" });
    expect(view.textContent).not.toContain("Book the Lisbon hotel we compared.");
    expect(view.querySelector('[data-symbol="checkmark"]')).toBeNull();
  });

  it("shows the server's status when a dismiss finds the card taken elsewhere", async () => {
    rpc.mockResolvedValue({ status: "taken" });
    const { container: view, press } = renderOffer(card);
    await press("menu:dismiss");
    expect(view.textContent).toBe("Book the hotel");
    expect(view.querySelector('[data-symbol="checkmark"]')).not.toBeNull();
  });

  it("shows a taken card as done and opens the message it sent", async () => {
    const { press, onOpenMessage } = renderOffer({
      ...card,
      status: "taken",
      takenMessageId: "msg-9",
    });
    await press("Book the hotel");
    expect(onOpenMessage).toHaveBeenCalledWith("msg-9");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows a taken card without a message as plain text, not a button", () => {
    const { container: view } = renderOffer({ ...card, status: "taken" });
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent).toContain("Book the hotel");
  });

  it("treats a card another device took as done, without an error", async () => {
    rpc.mockRejectedValue(
      Object.assign(new Error("x"), { data: { reason: "card_closed", status: "taken" } }),
    );
    const { container: view, press } = renderOffer(card);
    await press("Book the hotel");
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.textContent).not.toContain("Book the Lisbon hotel we compared.");
  });
});
