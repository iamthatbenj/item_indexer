# Family Belongings

A private family record of belongings and their stories. Next.js/TypeScript, Turso-compatible libSQL, and (in later slices) private Cloudflare R2 storage.

Implemented so far: [#2](https://github.com/iamthatbenj/item_indexer/issues/2), approved founder sign-in and private collection creation, deployed through [#3](https://github.com/iamthatbenj/item_indexer/issues/3); plus [#4](https://github.com/iamthatbenj/item_indexer/issues/4), email-bound family invitations, member sign-in, and collection switching. See the [invitation behavior and migration/deployment ordering](docs/development/family-invitations.md) before shipping #4. Photos and exports are not implemented yet. Product scope: [`docs/prd.md`](docs/prd.md).

## Local setup

Requires Node.js 22.9+ and npm; Node.js 24 is recommended.

```sh
npm ci
cp .env.example .env.local
# Generate a secret; put the output in AUTH_SECRET in .env.local:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run db:migrate
npm run founder:approve -- you@example.com
npm run dev
```

Open **http://localhost:3000** (the exact `APP_ORIGIN` configured in `.env.local`). Request a code for the approved email. Development messages are private local JSON files under `.local/outbox/`; open the matching message to retrieve the code. They are not exposed through a web endpoint or printed in server logs. Delete the outbox when no longer needed: it contains usable sign-in codes and email addresses.

Then sign in, create a collection, and return to it. Administrators can invite relatives by email; an invited relative signs in, reviews the joining terms from **Your invitations**, and accepts before accessing the collection. Members can switch among their own collections. Use **Sign out** on shared devices. Public signup is unavailable; only approved founders can create collections.

### Operator commands

```sh
npm run db:migrate
npm run founder:approve -- relative@example.com
npm run founder:revoke -- relative@example.com
```

These commands require direct database credentials (or local file access); there is no public founder-approval endpoint. Restrict credentials to the operator and the server environment. Migration files are versioned/checksummed; rerunning is safe, but editing an already-applied migration is rejected. Add new migrations instead. Migrations are an explicit deployment step, not performed during an ordinary web request or build.

Revoking **founder approval** prevents creation of further collections and removes founder-only sign-in eligibility. Current members and identities with active invitations can still sign in. It does **not** remove existing collection membership or terminate existing sessions. Membership/access management is ticket #5. See [`docs/development/founder-journey.md`](docs/development/founder-journey.md) for session and security behavior.

## Verification

```sh
npx playwright install chromium
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Playwright starts its own server on `127.0.0.1:3100`, with a new isolated file database and captured email. Each run **replaces `.local/e2e/` only**; never put real records there. Tests do not use `.env.local` database credentials or deliver actual email. Linux hosts may need Playwright browser system dependencies; follow the installer output for the host OS.

The browser/integration suite covers the founder and invitation journeys, durable records, collection isolation and switching, email-bound acceptance, code/invitation expiry/reuse/concurrency, throttling, session expiration/revocation, CSRF boundaries, failure rollback, migration upgrades/reruns, and mobile-width usability. This is not real-device or hosted-service acceptance.

## Production boundary

The founder pilot is hosted at **https://belongings.josefson.net** on Vercel with Turso and Resend SMTP. See the [hosted operator runbook](docs/development/hosted-founder-journey.md) for DNS, environment separation, explicit migrations/approval, deployment/rollback, acceptance evidence, and current baseline costs. Configure `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, a random `AUTH_SECRET`, an exact HTTPS `APP_ORIGIN`, and the SMTP variables documented in `.env.example`. File email delivery is rejected in production or with remote databases. Production SMTP requires encrypted transport and does not enable debug logging.

No R2 buckets or credentials are needed for this slice. Do not treat a successful build or the local test results as proof of live email delivery, provider pricing, or the full below-$10/month budget.
