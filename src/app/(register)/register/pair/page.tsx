import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Button, buttonVariants } from "@/components/ui/button";
import { authenticateDevice } from "@/lib/device/auth";
import { t } from "@/lib/i18n";
import { forgetThisTill } from "./actions";
import { PairForm } from "./pair-form";

export const metadata: Metadata = {
  title: `${t("pair.title")} · ${t("app.name")}`,
  robots: { index: false },
};

export default async function PairPage({
  searchParams,
}: {
  searchParams: Promise<{ for?: string }>;
}) {
  const device = await authenticateDevice();
  if (!device.ok) return <PairForm />;
  const wanted = z.uuid().safeParse((await searchParams).for);
  // Already paired and nobody asked for a different business: straight to the till.
  if (!wanted.success || wanted.data === device.orgId) redirect(`/register/${device.orgId}`);

  // Someone opened another business's till on a browser that is paired to this one. Say so, instead
  // of silently showing the first business.
  return (
    <main className="surface-solid bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 className="text-heading font-semibold">{t("pair.otherShopTitle")}</h1>
        <p className="text-muted-foreground">{t("pair.otherShopBody")}</p>
        <form action={forgetThisTill} className="flex flex-col gap-2">
          <Button type="submit" size="pay">
            {t("pair.forgetTill")}
          </Button>
          <p className="text-muted-foreground text-sm">{t("pair.forgetHint")}</p>
        </form>
        <Link
          href={`/register/${device.orgId}`}
          className={buttonVariants({ variant: "outline", size: "touch" })}
        >
          {t("pair.openThatTill")}
        </Link>
      </div>
    </main>
  );
}
