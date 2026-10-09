"use client";

import {
  BarChart3Icon,
  BoxesIcon,
  ClockIcon,
  ChevronsUpDownIcon,
  LayoutDashboardIcon,
  MenuIcon,
  PackageIcon,
  ReceiptIcon,
  SettingsIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";
import { ThemeMenuItems } from "@/components/theme-menu-items";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { signOutAction } from "@/lib/auth/actions";
import { t, type MessageKey } from "@/lib/i18n";

const items: { slug: string; label: MessageKey; Icon: typeof LayoutDashboardIcon }[] = [
  { slug: "dashboard", label: "nav.dashboard", Icon: LayoutDashboardIcon },
  { slug: "sales", label: "nav.sales", Icon: ReceiptIcon },
  { slug: "shifts", label: "nav.shifts", Icon: ClockIcon },
  { slug: "products", label: "nav.products", Icon: PackageIcon },
  { slug: "inventory", label: "nav.inventory", Icon: BoxesIcon },
  { slug: "customers", label: "nav.customers", Icon: UserRoundIcon },
  { slug: "staff", label: "nav.staff", Icon: UsersIcon },
  { slug: "reports", label: "nav.reports", Icon: BarChart3Icon },
  { slug: "settings", label: "nav.settings", Icon: SettingsIcon },
];

function NavList({
  orgId,
  collapsible,
  onNavigate,
}: {
  orgId: string;
  collapsible?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={t("nav.label")}>
      <ul className="flex flex-col gap-1">
        {items.map(({ slug, label, Icon }) => {
          const href = `/o/${orgId}/${slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={slug}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-sm border-l-[3px] px-3 text-sm font-medium transition-colors",
                  collapsible && "md:justify-center lg:justify-start",
                  active
                    ? "border-ember bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-transparent",
                )}
              >
                <Icon aria-hidden className={cn("size-5 shrink-0", active && "text-ember")} />
                <span className={cn(collapsible && "md:sr-only lg:not-sr-only")}>{t(label)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Brand({ collapsible }: { collapsible?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-3">
      <span className="text-sidebar-foreground font-display flex items-center gap-2.5 text-xl font-semibold tracking-tight">
        <span
          aria-hidden
          className="bg-ember text-ember-foreground grid size-8 shrink-0 place-items-center rounded-full text-base font-bold"
        >
          T
        </span>
        <span className={cn(collapsible && "md:sr-only lg:not-sr-only")}>{t("app.name")}</span>
      </span>
      <span aria-hidden className="bg-sidebar-border block h-px" />
    </div>
  );
}

/**
 * Back-office frame: dark left nav (icon rail on tablet, drawer on phone), top bar with the
 * organisation and user menu, glass content area. Pages render inside `children`.
 */
export function BackOfficeShell({
  orgId,
  orgName,
  role,
  email,
  children,
}: {
  orgId: string;
  orgName: string;
  role: "owner" | "manager" | "cashier";
  email?: string;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="bg-background min-h-screen md:grid md:grid-cols-[4.5rem_1fr] lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="bg-background sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("nav.skip")}
      </a>
      <aside className="sidebar-dark bg-sidebar text-sidebar-foreground hidden flex-col gap-6 px-3 py-4 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
        <Brand collapsible />
        <NavList orgId={orgId} collapsible />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="surface-glass sticky top-0 z-30 flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 px-4 md:px-6">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger
              render={<Button variant="outline" size="icon-touch" className="md:hidden" />}
            >
              <MenuIcon aria-hidden />
              <span className="sr-only">{t("nav.open")}</span>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="sidebar-dark bg-sidebar text-sidebar-foreground gap-6 px-3 py-4"
            >
              <SheetTitle className="sr-only">{t("nav.label")}</SheetTitle>
              <Brand />
              <NavList orgId={orgId} onNavigate={() => setNavOpen(false)} />
            </SheetContent>
          </Sheet>

          <p className="font-display min-w-0 flex-1 truncate text-lg font-semibold">{orgName}</p>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="touch" className="max-w-56" />}
            >
              <UserRoundIcon aria-hidden />
              <span className="hidden truncate sm:inline">{t(`role.${role}`)}</span>
              <ChevronsUpDownIcon aria-hidden className="size-4 opacity-70" />
              <span className="sr-only">{t("user.menu")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="whitespace-normal">
                  {email ? t("user.signedInAs", { email }) : orgName}
                  <br />
                  {t("user.role", { role: t(`role.${role}`) })}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <ThemeMenuItems />
              <DropdownMenuSeparator />
              <form action={signOutAction}>
                <DropdownMenuItem render={<button type="submit" className="w-full" />}>
                  {t("user.signOut")}
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
