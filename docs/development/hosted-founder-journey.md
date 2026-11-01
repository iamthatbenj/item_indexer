# Hosted founder journey: operator runbook

Scope: [ticket #3](https://github.com/iamthatbenj/item_indexer/issues/3). This activates the founder journey, not invitations, photo capture, exports, or the complete preservation service. See [implementation/security behavior](founder-journey.md).

## Deployment and domains

- Application: **https://belongings.josefson.net**, Vercel, GitHub repository `iamthatbenj/item_indexer`, production branch `main`, Next.js preset, Node.js 24.
- Records: a dedicated production Turso database. Keep its URL/token in secret management; they are deliberately absent here.
- Sender: **Family Belongings <signin@notify.josefson.net>**, using Resend SMTP with the verified `notify.josefson.net` domain.
- DNS is managed at the operator's registrar. Add the exact app CNAME target supplied by Vercel's Domains screen; do not assume a generic target. Wait for domain verification and HTTPS certificate issuance.
- Add Resend's exact verification/sending records at their specified subdomain names. Do not replace existing root mail records, alter `www.josefson.net`, or enable inbound receiving for this app. Keep open/click tracking disabled for sign-in messages.

The existing website and normal email are independent of this deployment. An existing domain still has its usual renewal cost.

## Environment separation and secrets

Set these in **Vercel → Project → Settings → Environment Variables**, scoped to **Production only**:

| Variable | Production value |
| --- | --- |
| `TURSO_DATABASE_URL` | Dedicated production database URL (`libsql://…`) |
| `TURSO_AUTH_TOKEN` | Token authorized for that database's reads/writes |
| `APP_ORIGIN` | `https://belongings.josefson.net` (no trailing slash) |
| `AUTH_SECRET` | Independently generated random secret, at least 32 characters |
| `MAIL_TRANSPORT` | `smtp` |
| `MAIL_FROM` | `Family Belongings <signin@notify.josefson.net>` |
| `MAIL_SMTP_HOST` | `smtp.resend.com` |
| `MAIL_SMTP_PORT` | `465` |
| `MAIL_SMTP_USER` | `resend` |
| `MAIL_SMTP_PASSWORD` | Resend API key; prefer sending-only permission restricted to the verified domain |

Do not set `NODE_ENV` manually or expose credentials via `NEXT_PUBLIC_` variables. Do not copy production secrets into Preview or Development environments. An unconfigured preview is not a usable test deployment; if one is needed, give it a separate database, auth secret, approved test identities, email credentials, and exact HTTPS origin. Enable available preview deployment protection. Do not send real family content to previews.

Generate the auth secret locally and enter it directly into secret settings:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Never paste secrets, codes, cookie values, or database exports into chat, GitHub issues, screenshots, or source control. Environment changes require a new deployment; they do not update an already-running deployment. Treat access to provider dashboards and the operator database token as privileged.

## Migrations and founder approval

These are explicit operator steps, not build hooks or web requests. Use the same dedicated production database as Vercel. Do not use local test resources (`.local/e2e/` is disposable).

For this activation, the operator supplied database credentials through `.local/production-database.env`, which is ignored by Git and restricted to mode `0600`. It contains `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; `FOUNDER_EMAIL` was also supplied for the initial approval. Next.js does not automatically load this operator file. Keep it private and remove it when no longer needed; keep durable credentials in secret management.

```sh
# Run from the repository root. These commands deliberately avoid .env.local.
node --env-file=.local/production-database.env --import tsx scripts/database.ts migrate
node --env-file=.local/production-database.env --import tsx scripts/database.ts approve you@example.com
# To stop future founder sign-ins and collection creation:
node --env-file=.local/production-database.env --import tsx scripts/database.ts revoke you@example.com
```

Replace the example email with the intended approved founder. The script does not automatically use `FOUNDER_EMAIL`. Never edit an applied migration: checksums reject that; add a new migration instead. Before future schema changes, assess compatibility with both the new deployment and rollback target, and take a recoverable backup using the agreed operational procedure once implemented.

Revoking founder approval does **not** terminate existing sessions or remove memberships. For emergency all-device sign-out, use privileged database access to invalidate the affected account's sessions; rotate compromised provider tokens separately. Rotating `AUTH_SECRET` invalidates pending codes but not existing sessions. Do not mistake any of these actions for the later membership-management feature.

## Deployment and rollback

1. Run the local browser suite, typecheck, build, and dependency audit before deploying a change.
2. Review any migrations and their rollback compatibility. Apply required backward-compatible migrations explicitly; stop if they fail.
3. Deploy the intended Git revision through Vercel, with the Production environment and exact production origin. Verify the production domain points to the intended deployment, not just that a build is green.
4. Repeat the hosted checks below. Record the Git revision/deployment reference in the release or issue evidence without secrets.
5. On a regression, use Vercel's **Instant Rollback** to the previous known-good production deployment where available. Hobby currently permits rollback only to the immediately previous production deployment; confirm it is actually healthy. If no suitable rollback exists, deploy a reviewed compatible Git revision instead.
6. Rollback changes the served deployment, not Turso data or migrations. It does not rebuild with newly edited environment settings. If configuration needs correction, make a new deployment with the corrected variables; verify previously deployed credentials have not been revoked before selecting a rollback target. Never roll back onto code incompatible with the current database schema.

Rollback is documented here, not claimed to have been exercised on the live pilot. Weekly backups and tested operational restoration are later tickets; this pilot is not yet ready to be relied on as the sole family record.

## Hosted acceptance evidence

Checked **2026-11-01 UTC**:

- The operator reported Resend's sending domain verified, and completed the Vercel/custom-domain setup.
- The initial migration applied successfully to the configured remote Turso database; initial founder approval succeeded. No credential values or founder email are published here.
- The operator confirmed actual code arrival and successful sign-in, created a family collection, then signed out and signed in from a fresh private browser window; the collection remained accessible.
- HTTPS `/sign-in` returned HTTP 200 with private/no-store caching and security headers.
- A signed-out GET for an **existing** production collection returned HTTP 307 to `/sign-in`; its identifier and content were not published.
- Anonymous collection creation returned HTTP 303 to sign-in; a foreign-origin creation POST returned HTTP 403. Database counts were unchanged by these probes.
- An unapproved synthetic identity requested/redeemed a code through the hosted endpoints: sign-in redirects, no session cookie, and no account, founder approval, or email challenge created. No email delivery was triggered for that identity.
- The operator confirmed the live cookie's name/security flags and subsequently verified in Firefox that it disappears after sign-out. A `Session` expiry is expected when trusted-device persistence was not selected; it does not mean sign-out should retain the cookie.
- Two fresh Chromium contexts then exercised the actual hosted sign-out route with an isolated, random dummy session cookie (not an authenticated session). Both received HTTP 303 and an expired `__Host-family_session` cookie with Secure, HttpOnly, and path `/`; Chromium removed it in both runs. No family records were accessed. The operator also confirmed cookie removal in Firefox; no hosted cookie-clearing defect was reproduced.
- Local validation of the deployed implementation/review fix: 17 Chromium tests, typecheck, production build, and diff checks passed. Coverage includes real database isolation, code failure paths, revocation, and HTTPS-browser removal of a production-prefixed cookie through the application's policy and Next serializer.

The operator confirmed active plans are Vercel Hobby, Turso Free, and Resend Free, without paid add-ons or expiring paid trials.

The operator corrected the environment-variable scopes to Production only, redeployed, and confirmed that no Preview deployments existed before the correction. No old Preview deployments therefore require removal. All hosted acceptance checks for #3 are complete.

For future scope changes, existing deployments retain their configuration: delete affected Preview deployments or replace them with separately configured isolated resources. Do not assume an environment-scope edit revokes old deployments' access. Remove downloaded development copies where not needed; rotate credentials if untrusted code/people may have accessed them. No credential exposure is asserted merely from the former shared scope.

No intentional production outage or secret leak was induced. Generic production error handling is covered locally; the hosted checks are not an independent security audit. Cross-account isolation has automated local coverage; no second real hosted identity was enrolled for this activation.

## Baseline costs and limits

Public plan documentation rechecked **2026-11-01 UTC**; the operator confirmed the intended free plans are active. These are allowances, not verified account invoices or a service-wide billing cap.

| Service | Intended plan / baseline | Relevant constraints |
| --- | --- | --- |
| Vercel | Hobby, $0/month | Personal, non-commercial use only; includes 100 GB fast data transfer, 1 million function invocations, 4 CPU-hours and 360 GB-hours provisioned memory. Limits are shared with other usage in the plan; exceeding allowances can pause features, usually until 30 days have passed. |
| Turso | Free, $0/month | 100 databases, 5 GB storage, 500 million rows read/month, 10 million rows written/month. Check actual usage and account allowances; do not enable paid overages without approval. |
| Resend | Free transactional, $0/month | 3,000 emails/month, maximum 100/day; SMTP included. Exhaustion can prevent sign-in delivery. Paid Pro starts at $20/month, already above this project's total target. |

With these plans the incremental listed baseline is **$0/month**, excluding the existing domain renewal and future storage/processing/backup usage. The complete service's **below-$10/month target remains unproven**. No paid upgrade is implicitly approved.

The current application's 30 code requests per 15-minute global window do **not** enforce Resend's daily/monthly allowance; abuse can exhaust it. Monitor provider usage manually during this small pilot. Later usage controls must address email, reads, processing, uploads, and warnings/pauses; this activation does not claim those controls are delivered.

Cloudflare R2 remains the agreed future private storage for photos, attachments, and exports. No R2 buckets or keys are needed for the founder journey, and this ticket does not change photo-retention/privacy decisions.

### Provider references

- [Vercel Hobby limits and personal-use restriction](https://vercel.com/docs/plans/hobby)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
- [Turso pricing](https://turso.tech/pricing)
- [Resend pricing](https://resend.com/pricing)
- [Resend SMTP configuration](https://resend.com/docs/send-with-smtp)
- [Resend verified domains](https://resend.com/docs/dashboard/domains/introduction)
