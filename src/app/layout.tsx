import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Belongings",
  description: "A private family record of belongings and their stories.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <a className="skip" href="#main">Skip to content</a>
    <header><Link href="/" className="brand">Family Belongings</Link><span>Keep the stories close.</span></header>
    <main id="main">{children}</main>
    <footer>A private place for your family’s belongings and memories.</footer>
  </body></html>;
}
