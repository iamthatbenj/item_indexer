# Founder journey: implementation and verification

Scope: [GitHub #2](https://github.com/iamthatbenj/item_indexer/issues/2), PRD stories 1, 3, 5, 69. Hosted activation is #3; [invitations and member sign-in](family-invitations.md) are #4. This describes the first application slice and its shared security behavior, not the full archive product.

## Boundaries

- Native POST forms target Node.js route handlers. Every write validates the exact configured `APP_ORIGIN`, rejects absent/foreign origins, and parses at most 4 KiB of URL-encoded input. No client-supplied return URL is followed.
- Referrer policy is `same-origin`: cross-origin requests do not receive private page URLs, while same-origin browser POSTs retain the Origin header required by the CSRF check. `no-referrer` would cause Chromium to send `Origin: null` for these navigational POSTs.
- Authenticated pages are rendered dynamically with private/no-store responses. Membership is checked in collection queries, not just the navigation or a client component. Existing-but-inaccessible collection IDs return the same 404 experience as nonexistent IDs to signed-in visitors; signed-out visitors go to sign-in.
- Stable random account/collection identifiers and atomic collection-plus-administrator creation establish collection isolation. Identifiers are not authorization grants.
- Application modules that expose auth, mail, and collection data are marked server-only. SQL uses bound parameters. No source contains credentials, real family records, or usable sign-in codes.
- The local migration/operator module is shared with scripts, so it is not marked server-only; nothing imports it into a client component. Founder approval requires direct privileged database access. There is deliberately no approval API.

## Email identity and one-time codes

Email normalization trims whitespace and lowercases; it does not rewrite provider aliases or remove dots. Approval uses the same normalization. This pilot uses email control, not knowledge of family facts, as identity proof.

Sign-in eligibility now includes approved founders, current collection members, and identities with unaccepted/unexpired invitations; eligibility is checked both when requesting and redeeming a code. This does not grant collection access before invitation acceptance. Only approved founders may create collections.

Codes are cryptographically random six-digit values, valid for **10 minutes**, with at most **five incorrect guesses per challenge**. A resend replaces the previous challenge. Successful redemption consumes the challenge in the same write transaction that creates a session, including competing redemption requests. A failed database operation rolls back the transaction.

Only an HMAC digest of the code (bound to the challenge identity and email) is stored in the database. `AUTH_SECRET` must be independently generated, at least 32 characters, and never sent to browsers. Rotating it invalidates outstanding code digests and resets keyed rate-limit scopes; it does not revoke existing sessions.

Code requests always redirect to the same non-enumerating acknowledgement for approved, unknown, throttled, and delivery-failed addresses. Verification failures share one message. Do not interpret that as a guarantee against every email-delivery timing side channel. Invalid email syntax has its own validation message.

Email is delivered outside the database write transaction. If delivery fails, remove only that delivery's challenge, preserving any later resend. The application logs a generic operational error, not the code or transport exception. Development file delivery is restricted to a local file database and non-production runtime, with private file permissions and a non-public outbox. It is intentionally a privileged filesystem test/development seam, not an HTTP test endpoint.

SMTP is configurable using host/port/user/password/from variables. Port 465 uses implicit TLS; other supported ports require STARTTLS. Actual provider selection, credentials, domain verification, delivery testing, and hosting are not proven by this slice.

## Sessions

- Session tokens have 256 bits of cryptographic randomness. The database stores a SHA-256 digest, not the cookie value.
- Normal sign-in: browser-session cookie, with **12-hour absolute server expiry**. Browser session restoration can retain a session cookie, so closing a browser is not promised to revoke access.
- Trusted-device sign-in: persistent cookie with **30-day absolute expiry**, also enforced server-side. Activity does not extend that bound.
- Cookies are HttpOnly, SameSite=Lax, path `/`; production additionally uses Secure and the `__Host-` cookie prefix. Always use HTTPS in production.
- Sign-out deletes the current database session and clears its cookie. Replaying that old cookie fails. Other signed-in devices are not signed out by this action.
- Revoking founder approval removes outstanding challenges and prevents further collection creation. It removes founder-only sign-in eligibility, but current members or actively invited identities may still sign in. Existing sessions may still access their collection memberships. [Membership management](family-membership.md) revokes access to one collection without terminating sessions or affecting other memberships. All-device sign-out remains a separate privileged operation, not an undocumented side effect of founder revocation.
- The same operator credentials that approve founders can invalidate sessions directly if necessary. Treat database access as privileged. Expired sessions and challenges are opportunistically pruned; no backup/retention promise is added by this slice.

## Initial abuse protection

Counters live in the database, not process memory, and are updated atomically across application instances. Fixed **15-minute windows** enforce:

| Operation | Per normalized email | Service-wide |
| --- | --- | --- |
| Request a code | 3 | 30 |
| Verify a code | 10 | 300 |

The five-guess challenge limit also applies. A resend does not reset the per-email verification window. Email scopes are keyed digests; the service does not trust arbitrary forwarded IP headers for identity. Old windows are pruned. [Invitations](family-invitations.md) add separately namespaced send limits; combined traffic is not bounded by these sign-in limits alone.

These deliberately conservative pilot limits can temporarily deny legitimate requests during abuse and permit bursts at a fixed-window boundary. They are not comprehensive DDoS prevention or a spending cap. Broader usage controls/observability belong to #33–#34. Operator review is needed before changing limits for production usage.

## Data and migration seams

`src/server/database.ts` uses `@libsql/client`: local `file:` databases for development/tests and remote Turso URLs/tokens for deployment. Use the primary connection for authoritative access checks, not a lagging read replica.

`migrations/` defines the shipped tables. The migration runner records a checksum and applies each new migration atomically. It does not create unused future invitation/photo/transfer tables. Collection membership is separate from an account and from founder approval. Future people/storytellers are not equated with account records.

`src/server/auth.ts` owns code/session behavior; `security.ts` shares eligibility, HMAC digests, and rate counters; `collections.ts` owns scoped collection queries/creation; `invitations.ts` owns scoped invitation/join behavior; `memberships.ts` owns administrator changes and collection-scoped removal; `mail.ts` owns delivery. No live-provider credentials are required to test their combined behavior through route handlers and the browser.

## Test evidence

`tests/founder.spec.ts` exercises the actual app with a real isolated libSQL database and local captured email. Direct database writes in tests only establish fixtures/faults (expiry, exhausted windows, rollback triggers); assertions verify observable application behavior and durable results.

Covered cases include:

- Operator approval normalization/idempotence and collection administrator persistence.
- Trusted-session return and short server expiry.
- Unknown visitor rejection and identical code-request acknowledgement.
- Incorrect, expired, reused, superseded, and concurrently redeemed codes.
- Per-email/global request and verification limits, including challenge exhaustion.
- Sign-out and failed replay of a previously valid cookie.
- Cross-account collection/list isolation and unauthenticated access.
- Revoked founder creation permissions, foreign/missing Origin, oversized forms, invalid names.
- Failed email delivery, atomic rollback when membership assignment fails, and migration reruns preserving content.
- A narrow mobile browser viewport without horizontal overflow.

[Hosted activation/runbook for #3](hosted-founder-journey.md) records the real Turso connection, Resend SMTP delivery, domain/TLS, deployed acceptance checks, remaining operator confirmations, and baseline pricing. Physical phone/assistive-technology review and final pilot cost/acceptance are later manual work. Automated local success is not a production security audit.
