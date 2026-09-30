import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-semibold tracking-tight">Tillflow POS</h1>
      <nav aria-label="Account" className="flex gap-4 text-sm">
        <Link href="/login" className="underline underline-offset-4">
          Log in
        </Link>
        <Link href="/signup" className="underline underline-offset-4">
          Create an account
        </Link>
      </nav>
    </main>
  );
}
