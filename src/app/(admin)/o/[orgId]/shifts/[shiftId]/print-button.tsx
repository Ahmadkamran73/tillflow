"use client";

import { PrinterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export function PrintButton() {
  return (
    <Button
      type="button"
      size="touch"
      variant="outline"
      className="print:hidden"
      onClick={() => window.print()}
    >
      <PrinterIcon aria-hidden /> {t("shifts.report.print")}
    </Button>
  );
}
