import { MenuView } from "@expo/ui/community/menu";
import type { ActionOfferCard, ActionOfferStatus } from "@rakazo/contracts";
import { effectiveOfferStatus } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

/** One action card in a thread; its state arrives with the message. */
export function OfferCard({
  card,
  onOpenMessage,
}: {
  card: ActionOfferCard;
  onOpenMessage?: (messageId: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const [settled, setSettled] = useState<ActionOfferStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSettled(null), [card.status]);
  const status = settled ?? effectiveOfferStatus(card, new Date());
  const label = card.kind === "save_skill" ? t("Save as a skill") : card.label;

  if (status === "taken") {
    const done = (
      <>
        <NativeSymbol
          ios="checkmark"
          android="checkmark"
          size={14}
          color={tokens.mutedForeground}
        />
        <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
      </>
    );
    const row = { flexDirection: "row", alignItems: "center", gap: 6 } as const;
    const messageId = card.takenMessageId;
    if (!messageId || !onOpenMessage) return <View style={row}>{done}</View>;
    return (
      <Pressable accessibilityRole="button" onPress={() => onOpenMessage(messageId)} style={row}>
        {done}
      </Pressable>
    );
  }
  if (status !== "open") return <Text style={{ color: tokens.mutedForeground }}>{label}</Text>;

  async function send(action: "take" | "dismiss") {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (action === "take") {
        await rpc("actionOffers/take", { offerId: card.id });
        setSettled("taken");
      } else {
        // A card taken on another device stays taken.
        const { status } = await rpc("actionOffers/dismiss", {
          offerId: card.id,
        });
        setSettled(status);
      }
    } catch (err) {
      const data = (
        err as { data?: { reason?: string; status?: ActionOfferStatus; botName?: string } }
      ).data;
      if (data?.reason === "card_closed" && data.status) setSettled(data.status);
      else if (data?.reason === "waiting_for_answer") {
        setError(t("Answer {bot}'s question first.", { bot: data.botName ?? "" }));
      } else if (data?.reason === "left_group") setError(t("That bot has left this group."));
      else setError(errorText(err, t("Please try again.")));
    } finally {
      setPending(false);
    }
  }

  const body = (
    <View
      style={{
        maxWidth: 576,
        gap: 8,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <NativeActionButton
        label={label}
        busy={pending}
        disabled={readOnly}
        onPress={() => void send("take")}
      />
      <Text style={{ color: tokens.mutedForeground }}>{card.task}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
  if (readOnly) return body;
  return (
    <MenuView
      actions={[{ id: "dismiss", title: t("Dismiss") }]}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "dismiss") void send("dismiss");
      }}
    >
      {body}
    </MenuView>
  );
}
