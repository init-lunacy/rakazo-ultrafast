import { MenuView } from "@expo/ui/community/menu";
import type { BrowserTabs } from "@rakazo/contracts";
import { View } from "react-native";
import { browserTabChoice, browserTabMenu } from "../lib/computer-tabs";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

/** The bot's browser tabs as a native menu: the shown one checked, and Follow while pinned. */
export function ComputerTabsMenu({
  tabs,
  onShow,
}: {
  tabs: BrowserTabs | undefined;
  onShow: (target: string | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const actions = browserTabMenu(tabs, t("Follow"));
  if (actions.length === 0) return null;
  return (
    <MenuView
      actions={actions}
      colorScheme={colorScheme}
      onPressAction={({ nativeEvent }) => {
        const choice = browserTabChoice(nativeEvent.event);
        if (choice !== undefined) onShow(choice);
      }}
      title={t("Tabs")}
    >
      {/* A plain view, as in ComputerMaintenanceActions: a Pressable would take the tap from the menu. */}
      <GlassSurface
        shape="circle"
        style={{ width: 36, height: 36 }}
        fallbackStyle={{ borderRadius: 18 }}
      >
        <View
          accessibilityRole="button"
          accessibilityLabel={t("Tabs")}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <NativeSymbol
            ios="square.on.square"
            android="copy-outline"
            size={16}
            color={iosAtLeast(26) ? tokens.foreground : tokens.mutedForeground}
          />
        </View>
      </GlassSurface>
    </MenuView>
  );
}
