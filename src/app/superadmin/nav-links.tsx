"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; match?: string[] };

/**
 * A list of links that marks the current page: aria-current plus a visual cue that is not colour
 * alone (a tick and a filled pill). A link is current on its own path or below it, or on any of its
 * `match` paths (so /superadmin/orgs/<id> keeps "Businesses" current while /superadmin/billing does not).
 */
export function NavLinks({ items, variant }: { items: NavItem[]; variant: "header" | "pills" }) {
  const pathname = usePathname();
  const isCurrent = (i: NavItem) =>
    pathname === i.href ||
    (i.match ?? [i.href]).some((m) => pathname === m || pathname.startsWith(`${m}/`));
  return (
    <ul className={variant === "pills" ? "flex flex-wrap gap-2" : "flex gap-4 text-sm font-medium"}>
      {items.map((i) => {
        const current = isCurrent(i);
        return (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={current ? "page" : undefined}
              className={
                variant === "pills"
                  ? `inline-flex min-h-12 items-center rounded-full border-2 px-4 text-sm font-medium ${
                      current ? "border-foreground bg-foreground text-background" : "border-border"
                    }`
                  : `inline-flex min-h-12 items-center underline ${current ? "font-bold" : ""}`
              }
            >
              {current ? <span aria-hidden>✓&nbsp;</span> : null}
              {i.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
