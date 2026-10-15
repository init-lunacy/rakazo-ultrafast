import { MenuView } from "@expo/ui/community/menu";
import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabChoice, browserTabMenu } from "../lib/computer-tabs";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { GlassIconButton } from "./glass-icon-button";

/** The bot's browser tabs as a native menu: the shown one checked, and Follow while pinned. */
export function ComputerTabsMenu({
  tabs,
  onShow,
}: {
  tabs: BrowserTabs | undefined;
  onShow: (target: string | null) => void;
}) {
  const { t } = useI18n();
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
      {/* No onPress: the button is the menu's trigger. */}
      <GlassIconButton
        accessibilityLabel={t("Tabs")}
        ios="square.on.square"
        android="copy-outline"
        size={36}
        iconSize={16}
      />
    </MenuView>
  );
}
