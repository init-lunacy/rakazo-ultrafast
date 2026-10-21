import type { ActionOfferListItem } from "@rakazo/contracts";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { OfferCard } from "../components/OfferCard";
import { offerRoute } from "../lib/action-offers";
import type { MobileSpaceNavigation } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Open action cards from every chat, each under its chat's name. */
export default function ActionsSheet() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [items, setItems] = useState<ActionOfferListItem[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        try {
          const [list, navigation] = await Promise.all([
            rpc<ActionOfferListItem[]>("actionOffers/list"),
            rpc<MobileSpaceNavigation>("spaces/list"),
          ]);
          if (cancelled) return;
          setItems(list);
          setNames(
            new Map([
              ...navigation.current.bots.map((bot) => [bot.id, bot.name] as const),
              ...navigation.current.groups.map((group) => [group.id, group.name] as const),
            ]),
          );
        } catch {
          // The next tick retries; the list keeps what it last showed.
        }
        if (!cancelled) timer = setTimeout(() => void tick(), 5_000);
      };
      void tick();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, []),
  );
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ gap: 16, padding: 16 }}
      ListHeaderComponent={
        <Text
          accessibilityRole="header"
          style={{ fontSize: 20, fontWeight: "600", color: tokens.foreground }}
        >
          {t("Actions")}
        </Text>
      }
      renderItem={({ item }) => (
        <View style={{ gap: 6 }}>
          <Pressable accessibilityRole="link" onPress={() => router.push(offerRoute(item))}>
            <Text style={{ color: tokens.mutedForeground }}>
              {names.get(item.groupId ?? item.botId) ?? ""}
            </Text>
          </Pressable>
          <OfferCard card={item} />
        </View>
      )}
    />
  );
}
