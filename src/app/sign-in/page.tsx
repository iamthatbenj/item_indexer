import { redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await currentAccount()) redirect("/");
  const query = await searchParams;
  const email = typeof query.email === "string" ? query.email.slice(0, 254) : "";
  return <>
    <p className="eyebrow">The family record</p>
    <h1>Belongings carry stories.</h1>
    <p className="intro">Keep your family’s memories together, in a private collection you can return to.</p>
    {query.out && <p role="status" className="notice">You have signed out of this device.</p>}
    {query.sent && <p role="status" className="notice">If this email has access, a sign-in code is on its way. Codes expire after 10 minutes. If it does not arrive, wait before trying again.</p>}
    {query.error && <p role="alert" className="notice error">{query.error === "email" ? "Enter a valid email address." : "That code could not be used. Check your email and code, or request a new one."}</p>}
    <div className="panels">
      <section className="card" aria-labelledby="request-heading">
        <h2 id="request-heading">Get a sign-in code</h2>
        <p>Use your invited or approved email address. There is no public signup. After signing in, you can review your invitations from Your collections.</p>
        <form action="/auth/request" method="post">
          <label htmlFor="request-email">Email address</label>
          <input id="request-email" name="email" type="email" autoComplete="email" maxLength={254} required defaultValue={email} />
          <button type="submit">Send sign-in code</button>
        </form>
      </section>
      <section className="card" aria-labelledby="verify-heading">
        <h2 id="verify-heading">Already have a code?</h2>
        <form action="/auth/verify" method="post">
          <label htmlFor="verify-email">Email for this code</label>
          <input id="verify-email" name="email" type="email" autoComplete="email" maxLength={254} required defaultValue={email} />
          <label htmlFor="code">Six-digit code</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
          <label className="check"><input name="trusted" type="checkbox" value="yes" /> Keep me signed in on this trusted device</label>
          <p className="hint">Up to 30 days on a trusted device. Otherwise, your session lasts at most 12 hours. Do not use a shared device for a trusted session.</p>
          <button type="submit">Sign in</button>
        </form>
      </section>
    </div>
  </>;
}
