# Family administrators and membership removal

Scope: [ticket #5](https://github.com/iamthatbenj/item_indexer/issues/5), PRD stories 8, 9, 12. This adds access management, not editorial approval, account erasure, or withdrawal of contributions. [Invitations](family-invitations.md) remain the way to join a collection.

## Using the interface

On a family collection page, an administrator follows **Manage family members and administrators**. The administrator-only page lists current members by sign-in email and role, identifies the current account, and offers:

- **Make administrator** for a current ordinary member.
- **Make family member** to remove administrator responsibility without changing editorial rights.
- **Remove access**, with an explicit acknowledgement that contributions remain and copies cannot be recalled.

An administrator may change their own role or remove their own access only while another administrator remains. Successful self-demotion returns to the collection as an ordinary member; successful self-removal returns to the collection list. A rejection explains how to appoint another administrator first. There is no account-wide deletion or automatic removal of that person's stories.

Only administrators can see this membership-management directory. Ordinary members retain their shared-record editing rights but cannot promote, demote, remove access, or obtain this administrator-only directory. Administrator responsibility never establishes ownership or greater editorial authority. Accounts/memberships are not Person or Storyteller records.

## Authorization and the final administrator

`src/server/memberships.ts` owns the authorization and persistence boundary. The management query checks current collection-scoped administrator membership in the same SQL snapshot as its result. Mutations check the current actor, target membership, and any remaining administrator inside one **write transaction**, then change only the requested collection's membership.

- Only a current member can be promoted; an invitation or arbitrary account ID is insufficient.
- Membership changes cannot leave zero administrators. The remaining administrator must have an actual account/membership, not just an invitation or an orphaned role row.
- Founder approval and active sessions are not prerequisites for being a usable administrator: membership enables future email-code sign-in. There is currently no disabled-account state. The app cannot detect whether someone has lost access to their mailbox; appoint a relative who can still sign in.
- Competing self-demotions/removals serialize: one succeeds and the attempt against the final administrator is rejected. Reciprocal changes also recheck the actor after the competing transaction, so a newly demoted/removed administrator cannot use a stale form to act.
- Repeating promotion/demotion to the current role is harmless. Missing target membership returns a generic 404; an unauthorized actor receives 403 without target details. The page returns the same 404 to ordinary members and unrelated accounts. Signed-out visitors go to sign-in.
- Native POSTs retain the shared exact-origin check, URL-encoded content restriction, 4 KiB body limit, generic failure handling, and server-side confirmation requirement for removal. No client-supplied role/account claim determines the actor's privileges.

All current data/action entry points check collection access on new requests. Do not add cached authorization decisions or use stale/lagging replica reads for membership enforcement. A request that was already authorized/in flight, a record already displayed, or a downloaded copy cannot be retroactively recalled.

## What removal changes—and what it preserves

Removal deletes that collection's membership and invalidates any still-pending invitation addressed to the same email in that collection, atomically. Removal itself leaves accepted invitation records in place, but their replay cannot rejoin a removed member. Returning requires a **fresh administrator invitation and acknowledgement**; rejoining retains the same account identity and starts with the ordinary member role, not the former administrator role. Reinvitation replaces the previous invitation record for that collection/email, including its ID, inviter, dates, and acceptance state. Invitation metadata is current workflow state, not a permanent invitation audit history.

It does **not** delete the account, sessions, founder approval, historical editor identity, or contributions. Invitations previously issued by the departing administrator to *other* relatives remain valid; removing the inviter is not a withdrawal of their earlier authorized invitations. No invitation-cancellation UI is added here.

A current session still proves identity but no longer grants access to the removed collection. The same cookie remains usable for memberships in other collections. Do not globally sign out a member as a substitute for per-collection revocation: doing so would unnecessarily disrupt unrelated families and would not itself remove membership.

Code request/redemption eligibility is derived from current founder approval, membership anywhere, or an active invitation. A removed person may still sign in for another collection or as an approved founder, but cannot access the removed collection. If none of those conditions remain, new code requests do not deliver mail and previously requested codes fail redemption. Existing sessions are not erased; they expose no removed collection data through new requests.

Downloaded/exported copies cannot be recalled. Future private R2 links already issued before removal may remain usable until their bounded expiry. Photo/file/export issuance is not shipped yet; each future endpoint must recheck current membership before issuing **new** authorization. This ticket does not claim to test nonexistent file/export endpoints or to revoke bearer links immediately.

Emergency **account-wide** all-device sign-out still requires privileged session invalidation; rotating `AUTH_SECRET` does not invalidate existing sessions. Founder approval, membership, and session revocation are separate operations.

## Verification

`tests/memberships.spec.ts` exercises native browser forms and direct HTTP requests against an isolated real libSQL database, with separate founder/member/outsider browser identities and local captured sign-in/invitation email. Shared browser journey helpers live in `tests/support/family.ts`; each spec owns its database client. No production credentials or real email delivery are required.

Coverage includes promotion/demotion, administrator-directory privacy, ordinary/foreign/anonymous action denial, collection-scoped roles, explicit confirmation, stale administrator forms, copied session cookies after removal, unchanged access to another collection, final-administrator rejection, concurrent self-removal/demotion, reciprocal changes, rollback, safe reinvitation, and mobile keyboard/overflow checks.

The preservation test verifies that removal itself leaves an invitation issued by the departing administrator to a different relative unchanged, including its `invited_by` reference. This does not promise permanent retention of that invitation's metadata if its recipient is later reinvited. A **test-only durable contribution table** models content with an independent `recorded_by` account reference; its text, collection link, historical account ID/email, and account record survive removal and reinvitation unchanged. This is a fixture, not a prematurely shipped story schema or a claim that account identity equals storyteller credit. Keep this regression and extend it through actual item/story/history/export boundaries when those slices arrive. No PDFs or portable archives exist yet to extend.

The rollback test injects a database failure during membership deletion after pending-invitation invalidation; both changes roll back, and a subsequent real form submission succeeds. No exception text or credentials are returned to the client.

## Deployment and rollback

No new migration, environment variable, resource, or secret is required for #5. The database must already have migrations #1 and #2. Local checks are `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and `git diff --check`.

Deploy only after review/operator approval. For hosted verification, use consenting test identities: promote a relative, verify their management access, remove access while another session remains open, and confirm a new request fails while another collection remains accessible. Check keyboard/screen-reader behavior manually; automated label/keyboard checks do not replace assistive-technology testing. Do not remove the final real administrator or use irreplaceable records as a test.

Application rollback to #4 is schema-compatible: it does not undo promotions, demotions, or removals, and removed memberships remain unauthorized. The #4 version has no management UI, so prefer a compatible fix-forward when further access changes are required. Rollback does not recall copies, restore a removed membership, or serve as an operational data backup.
