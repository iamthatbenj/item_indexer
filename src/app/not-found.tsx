import Link from "next/link";

export default function NotFound() {
  return <><h1>Collection not found</h1><p>It may not exist, or you may not have access to it.</p><Link href="/">Return to your collections</Link></>;
}
