import { cn } from "cn";

/**
 * Register frame: two solid panes. Tiles and search on the left, cart and Pay on the right.
 * Designed for landscape >= 1024x768 (panes scroll on their own, the total never moves). Below
 * that width the panes stack and `bar` (total + Pay) is pinned to the bottom of the screen.
 */
export function RegisterLayout({
  header,
  tiles,
  cart,
  bar,
}: {
  header: React.ReactNode;
  tiles: React.ReactNode;
  cart: React.ReactNode;
  bar: React.ReactNode;
}) {
  return (
    <div className="bg-background flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <header className="surface-solid border-b-primary flex min-h-16 flex-wrap items-center gap-3 border-0 border-b-4 px-4 py-2">
        {header}
      </header>
      <main className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[1fr_24rem]">
        <section className="flex flex-col gap-4 p-4 pb-28 lg:min-h-0 lg:overflow-y-auto lg:pb-4">
          {tiles}
        </section>
        <section
          aria-labelledby="register-cart-heading"
          className={cn(
            "bg-muted lg:border-solid-border flex flex-col p-4 pb-28 lg:min-h-0 lg:border-l-2 lg:pb-4",
          )}
        >
          {cart}
        </section>
      </main>
      <div className="surface-solid border-t-input fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-0 border-t p-3 lg:hidden">
        {bar}
      </div>
    </div>
  );
}
