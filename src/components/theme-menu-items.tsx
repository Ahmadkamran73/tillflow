"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";

const options = [
  { value: "light", label: "theme.light", Icon: SunIcon },
  { value: "dark", label: "theme.dark", Icon: MoonIcon },
  { value: "system", label: "theme.system", Icon: MonitorIcon },
] as const;

/** Theme radio group for a dropdown menu. */
export function ThemeMenuItems() {
  const { theme = "system", setTheme } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
        {options.map(({ value, label, Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon aria-hidden /> {t(label)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
