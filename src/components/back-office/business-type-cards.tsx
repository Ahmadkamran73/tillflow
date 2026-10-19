"use client";

import {
  CheckIcon,
  CoffeeIcon,
  ShirtIcon,
  SmartphoneIcon,
  StoreIcon,
  UtensilsCrossedIcon,
} from "lucide-react";
import { businessTypes, type BusinessType } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";

const icons = {
  general: StoreIcon,
  electronics: SmartphoneIcon,
  clothing: ShirtIcon,
  cafe: CoffeeIcon,
  restaurant: UtensilsCrossedIcon,
} satisfies Record<BusinessType, unknown>;

type Props = {
  value?: BusinessType | "";
  defaultValue?: BusinessType;
  onValueChange?: (type: BusinessType) => void;
  describedBy?: string;
};

/** Five large radio cards. The selected one gets a thick border and a tick, not just a colour. */
export function BusinessTypeCards({ value, defaultValue, onValueChange, describedBy }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {businessTypes.map((type) => {
        const Icon = icons[type];
        return (
          <label
            key={type}
            className="surface-panel border-input has-[:checked]:border-ember has-[:focus-visible]:outline-ring relative flex min-h-36 cursor-pointer flex-col gap-2 border-2 p-4 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2"
          >
            <input
              type="radio"
              name="businessType"
              value={type}
              className="sr-only"
              {...(value !== undefined
                ? { checked: value === type, onChange: () => onValueChange?.(type) }
                : { defaultChecked: defaultValue === type })}
              aria-labelledby={`bt-${type}-title`}
              aria-describedby={[`bt-${type}-desc`, describedBy].filter(Boolean).join(" ")}
            />
            <Icon aria-hidden className="size-10" strokeWidth={1.5} />
            <span id={`bt-${type}-title`} className="font-display text-heading font-semibold">
              {t(`businessType.${type}`)}
            </span>
            <span id={`bt-${type}-desc`} className="text-muted-foreground text-sm">
              {t(`businessType.${type}.description`)}
            </span>
            <span
              aria-hidden
              className="bg-ember text-ember-foreground absolute top-3 right-3 hidden size-7 items-center justify-center rounded-full [label:has(:checked)_&]:flex"
            >
              <CheckIcon className="size-4" />
            </span>
          </label>
        );
      })}
    </div>
  );
}
