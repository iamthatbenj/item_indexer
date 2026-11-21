# Rename and merge shared labels (#21)

Open **Manage categories and locations** from a family collection. Any member can preview an operation and confirm it. Preview shows the source, destination, and number of current items affected. If the relevant names or affected items change before confirmation, review again. Labels do not control access.

Rename changes the name of the same label everywhere it is referenced, including in history; it does not create individual item edits. Merge moves current assignments to the chosen active label of the same kind, saving each moved item's previous version and credit in the same transaction. The retired label's last name remains visible in earlier item versions and is reserved against accidental recreation. Historical recovery offers the active destination rather than reactivating a retired label. Repeating a completed move to the same still-active destination does not create revisions; a different destination requires reviewing the remaining active labels.

New PDFs use the active organization at generation time. Existing PDFs and archives are unchanged. Archives with retired labels use format 1.3; restoration preserves item history and remaps retired labels to the new active destination IDs.

## Rollout

Apply `0014_label_management.sql` before any approved auto-deploying push. No storage or provider changes. After merges, prefer fixing forward: older apps do not distinguish retired labels and won't correctly preserve the merge relationship. In a disposable hosted collection, rename and merge as a non-admin member, check stale review and old item history, inspect both PDFs, and restore an archive.
