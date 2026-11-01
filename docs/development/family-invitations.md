# Family invitations and collection switching

Scope: [ticket #4](https://github.com/iamthatbenj/item_indexer/issues/4). Administrator promotion/removal and invitation cancellation UI are not part of this slice; membership management is #5. No item, photo, export, public sharing, or person/storyteller functionality is introduced.

## Behavior and privacy

- A family administrator invites a normalized email from the collection page. Permission is checked against current membership in the same write transaction that records the invitation. A role in another collection gives no authority here. Form-supplied account IDs/roles are not trusted.
- Invitations expire **seven days** after creation. Sending again to the same email/collection replaces the previous invitation ID and expiry; old links become unavailable. An existing member is not reinvited or demoted. An administrator can retry a failed/expired invitation by submitting the email again.
- Invitation IDs are random UUIDs used as locators, **not bearer authorization**. No collection name or recipient address is disclosed to a signed-out visitor or a different authenticated email. Signed-out links go to sign-in; after authentication, the home page lists that email's pending invitations. There is no client-supplied return URL or public signup.
- Approved founders, current collection members, and identities with an unaccepted, unexpired invitation may request/redeem email codes. Eligibility is rechecked during redemption. An invitation permits proving email identity, not reading a collection. An expired invitation alone cannot enable sign-in, even with a previously issued code. Accepted members can sign in later without founder approval or a current invitation.
- Joining requires an explicit POST acknowledgement of the displayed terms: equal editing, administrators' access-management rather than editorial authority, retained attribution after departure, whole-collection export rights including financial evidence, and the inability to revoke downloaded copies. Editing and export tools themselves are later slices.
- Acceptance checks the authenticated account's email, invitation ID, state, and expiry inside a write transaction. It creates an ordinary `member` membership and marks acceptance atomically. An existing membership keeps its role. Repeating/concurrently submitting an accepted invitation returns to the collection only while membership still exists; replay cannot rejoin after departure/removal. Opening a link never accepts automatically.
- A member may participate in multiple collections. Each collection page names the current collection and offers a membership-scoped navigation list with an accessible current-page indicator. Membership and administrator authority remain independent in each collection, with no address/location coupling.
- No person or storyteller record is inferred from an account or membership. There are no editorial read-only roles or administrator-only content-edit privileges. Actual content-edit authorization will build on collection membership when those features ship.

## Persistence and delivery

`0002_family_invitations.sql` adds `invitations`, with collection, recipient email, inviting account, creation/expiry/acceptance timestamps, and one current invitation per email/collection. Accepted invitations are retained for idempotence; replacing an invitation changes its ID. This is invitation state, not an attribution or edit-history implementation. Do not edit migration #1.

`src/server/invitations.ts` owns authorization, invitation queries, issuance, and atomic acceptance. `src/server/security.ts` shares sign-in eligibility, HMAC digests, and durable rate counters with authentication. Every data/action entry point performs its own authorization; hiding the invite form is not the boundary.

Email uses the existing private file outbox in isolated development/tests and the configured TLS SMTP transport in production. Delivery runs outside the write transaction. A delivery failure removes only that unaccepted invitation ID, not a newer resend or an acceptance completed during delivery. The administrator sees retry guidance, not a successful-send claim or transport exception. A failed replacement does not restore its superseded link; retry sends a fresh one. Email delivery can be delayed or reordered; replaced links remain invalid.

Invitation sends use fixed 15-minute database-backed windows: **10 per administrator**, **3 per recipient email**, **30 service-wide**. Unauthorized actions and already-member requests do not send mail. These counters have separate namespaces from sign-in throttles; the combined traffic is **not** a provider daily/monthly allowance cap. Monitor the free Resend allowance during the pilot. Full budget controls remain later work.

## Deployment ordering

This migration is additive and compatible with the existing founder-only deployment. Before deploying #4, apply it explicitly to the intended production database using the [hosted runbook](hosted-founder-journey.md):

```sh
node --env-file=.local/production-database.env --import tsx scripts/database.ts migrate
```

Then deploy the #4 revision, keeping the production-only secrets and exact production origin. No new environment variables or provider resources are required. Do not let a Git push auto-deploy #4 before its migration is ready. Rolling the application back to the founder-only revision leaves the new table in place; do not drop it or erase memberships. That old code will not support invited/member-only sign-in, so prefer a compatible fix-forward where possible.

For emergency access changes, founder approval is not membership revocation: removing founder approval alone does not prevent a current member or actively invited identity from requesting a sign-in code. Existing sessions still need separate invalidation when required. #5 will provide the membership/access-management interface.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and `git diff --check` locally. Tests use only the disposable `.local/e2e/` database/outbox, never the operator production credential file or real email delivery.

`tests/invitations.spec.ts` uses independent browser identities and real native forms/routes, captured invitation/code emails, and durable database results. Coverage includes:

- A non-founder relative's email proof, pre-join denial, acknowledgement, ordinary membership, return sign-in, and inability to create collections or invite others.
- Forwarded links/wrong identities, signed-out requests, guessed collection identifiers, action authorization, and foreign-origin writes.
- Multiple collections, scoped roles/navigation, current collection identification, and mobile-width overflow.
- Seven-day expiry before sign-in, between code request/redemption, and between authentication/acceptance; invalid and superseded links.
- Repeated/concurrent acceptance, existing-member invitation behavior, role preservation, and rejection of replay after membership removal.
- Delivery failure/retry, per-recipient/per-administrator limits, permission changes before submission, and atomic rollback on membership failure.
- Upgrading an existing version-one database without losing founder records, memberships, or sessions, followed by sending an invitation.

Production migration, deployment, and real relative invitation delivery are not claimed by local test success. No preservation exports exist yet to extend; later archives must include the relevant durable membership/attribution semantics without treating a portable record as an access grant.
