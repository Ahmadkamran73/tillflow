import { PaletteIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SyncStatusPill } from "@/components/sync-status-pill";
import { ThemeMenuItems } from "@/components/theme-menu-items";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

const swatches = [
  ["background", "bg-background"],
  ["foreground", "bg-foreground"],
  ["card", "bg-card"],
  ["primary", "bg-primary"],
  ["secondary", "bg-secondary"],
  ["muted", "bg-muted"],
  ["accent", "bg-accent"],
  ["ember", "bg-ember"],
  ["success", "bg-success"],
  ["info", "bg-info"],
  ["destructive", "bg-destructive"],
  ["border", "bg-border"],
  ["input", "bg-input"],
  ["ring", "bg-ring"],
  ["sidebar", "bg-sidebar"],
  ["paper", "bg-paper"],
];

const typeScale = [
  ["text-amount", "Amount 12.60", "3rem · register totals"],
  ["text-display", "Display", "2.5rem · dashboard figures"],
  ["text-title", "Page title", "1.75rem"],
  ["text-heading", "Section heading", "1.25rem"],
  ["text-body", "Body text for reading and forms", "1rem"],
  ["text-caption", "Caption and helper text", "0.8125rem"],
];

const spacing = [1, 2, 3, 4, 6, 8, 12, 16];
const radii = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={title.replace(/W+/g, "-")} className="flex flex-col gap-4">
      <h2 id={title.replace(/W+/g, "-")} className="text-heading font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function DesignPage() {
  return (
    <div className="bg-background min-h-screen">
      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex max-w-xl flex-col gap-2">
            <h1 className="text-display font-semibold tracking-tight">{t("design.title")}</h1>
            <p className="text-muted-foreground">{t("design.intro")}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="touch" />}>
              <PaletteIcon aria-hidden /> {t("theme.label")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ThemeMenuItems />
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <Section title={t("design.colour")}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {swatches.map(([name, cls]) => (
              <li key={name} className="surface-panel flex flex-col gap-2 rounded-xl p-2 text-sm">
                <span className={`${cls} border-border h-14 rounded-lg border`} />
                <span className="font-medium">{name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("design.type")}>
          <div className="surface-panel divide-border divide-y rounded-xl">
            {typeScale.map(([cls, sample, note]) => (
              <div key={cls} className="flex flex-wrap items-baseline justify-between gap-2 p-4">
                <span className={`${cls} font-display font-semibold tabular-nums`}>{sample}</span>
                <span className="text-caption text-muted-foreground">
                  {cls} · {note}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("design.spacing")}>
          <div className="surface-panel flex flex-col gap-4 rounded-xl p-4">
            <ul className="flex flex-wrap items-end gap-3">
              {spacing.map((n) => (
                <li key={n} className="flex flex-col items-center gap-1 text-xs">
                  <span
                    className="bg-primary block"
                    style={{
                      width: `calc(var(--spacing) * ${n})`,
                      height: `calc(var(--spacing) * ${n})`,
                    }}
                  />
                  {n * 4}px
                </li>
              ))}
            </ul>
            <ul className="flex flex-wrap gap-3">
              {radii.map((r) => (
                <li key={r} className="flex flex-col items-center gap-1 text-xs">
                  <span className={`${r} bg-secondary border-input block size-14 border`} />
                  {r.replace("rounded-", "")}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title={t("design.surfaces")}>
          <div className="bg-sidebar grid gap-4 rounded-xl p-4 sm:grid-cols-2">
            <div className="surface-glass rounded-xl p-4">
              <h3 className="font-semibold">{t("design.glass")}</h3>
              <p className="text-muted-foreground text-sm">{t("design.glassBody")}</p>
            </div>
            <div className="surface-solid rounded-xl p-4">
              <h3 className="font-semibold">{t("design.solid")}</h3>
              <p className="text-muted-foreground text-sm">{t("design.solidBody")}</p>
            </div>
          </div>
        </Section>

        <Section title={t("design.buttons")}>
          <div className="surface-panel flex flex-wrap items-center gap-3 rounded-xl p-4">
            <Button size="touch">{t("common.save")}</Button>
            <Button size="touch" variant="secondary">
              {t("common.cancel")}
            </Button>
            <Button size="touch" variant="outline">
              {t("common.cancel")}
            </Button>
            <Button size="touch" variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button size="touch" variant="destructive">
              {t("common.delete")}
            </Button>
            <Button size="touch" disabled>
              {t("common.save")}
            </Button>
            <Button size="default">{t("common.save")}</Button>
            <Link
              href="/design/register"
              className={buttonVariants({ variant: "link", size: "touch" })}
            >
              {t("register.title")}
            </Link>
            <div className="w-full max-w-xs">
              <Button size="pay">{t("register.pay", { amount: "€12.60" })}</Button>
            </div>
          </div>
        </Section>

        <Section title={t("design.forms")}>
          <div className="surface-panel grid gap-4 rounded-xl p-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="d-email">{t("common.email")}</FieldLabel>
              <Input
                id="d-email"
                type="email"
                autoComplete="email"
                aria-describedby="d-email-hint"
                className="h-10"
              />
              <FieldDescription id="d-email-hint">{t("common.emailHint")}</FieldDescription>
            </Field>
            <Field data-invalid>
              <FieldLabel htmlFor="d-email2">{t("common.email")}</FieldLabel>
              <Input
                id="d-email2"
                type="email"
                defaultValue="aoife@shop"
                aria-invalid
                aria-describedby="d-email2-err"
                className="h-10"
              />
              <FieldError id="d-email2-err">{t("common.emailError")}</FieldError>
            </Field>
          </div>
        </Section>

        <Section title={t("design.feedback")}>
          <div className="surface-panel flex flex-wrap items-center gap-3 rounded-xl p-4">
            <Badge>{t("common.status.paid")}</Badge>
            <Badge variant="secondary">{t("common.status.trial")}</Badge>
            <Badge variant="destructive">{t("common.status.overdue")}</Badge>
            <Badge variant="outline">{t("role.manager")}</Badge>
            <SyncStatusPill state="online" />
            <SyncStatusPill state="offline" waiting={3} />
            <SyncStatusPill state="syncing" />
          </div>
        </Section>

        <Section title={t("design.data")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="surface-panel ring-0">
              <CardHeader>
                <CardTitle>{t("dashboard.emptyTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground">
                {t("dashboard.emptyBody")}
              </CardContent>
            </Card>
            <Tabs defaultValue="a" className="surface-panel rounded-xl p-4">
              <TabsList>
                <TabsTrigger value="a">{t("nav.sales")}</TabsTrigger>
                <TabsTrigger value="b">{t("nav.reports")}</TabsTrigger>
              </TabsList>
              <TabsContent value="a">{t("nav.sales")}</TabsContent>
              <TabsContent value="b">{t("nav.reports")}</TabsContent>
            </Tabs>
          </div>
          <div className="surface-panel rounded-xl p-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("nav.products")}</TableHead>
                  <TableHead className="text-right">{t("register.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Flat white</TableCell>
                  <TableCell className="text-right tabular-nums">€6.80</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Almond croissant</TableCell>
                  <TableCell className="text-right tabular-nums">€3.60</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <Dialog>
            <DialogTrigger
              render={<Button variant="outline" size="touch" className="self-start" />}
            >
              {t("common.openDialog")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("common.dialogTitle")}</DialogTitle>
                <DialogDescription>{t("common.dialogBody")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="touch" />}>
                  {t("common.cancel")}
                </DialogClose>
                <Button variant="destructive" size="touch">
                  {t("common.delete")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Section>

        <Section title={t("design.layouts")}>
          <div className="surface-panel flex flex-wrap gap-3 rounded-xl p-4">
            <Link
              href="/design/back-office"
              className={buttonVariants({ variant: "outline", size: "touch" })}
            >
              {t("nav.label")}
            </Link>
            <Link
              href="/design/register"
              className={buttonVariants({ variant: "outline", size: "touch" })}
            >
              {t("register.title")}
            </Link>
          </div>
        </Section>
      </main>
    </div>
  );
}
