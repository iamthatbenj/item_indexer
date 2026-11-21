# Shared categories and locations (#20)

Members can select, create, or clear one optional category and one optional location in the ordinary item editor. Refresh label choices to see another member’s additions without replacing local input. Labels are scoped to the collection and do not grant access, record an address, or change whether an item is complete. See [label management (#21)](label-management.md) for renaming and merging; hierarchy is out of scope.

Label names use up to 100 UTF-16 code units after trimming and NFC normalization. Creating the same lowercase normalized name in the same collection and label kind reuses its existing ID. The server checks current membership, item version, and the selected label’s collection before committing the edit. Label creation and assignment are atomic. Clearing an association does not delete the reusable label; item history and recovery retain the historical associations.

Inventory and catalogue PDFs include recorded labels from their saved snapshots. Archives with labels use [format 1.2](../../assets/portable-archive/FORMAT.md), preserving the label lists and current and historical associations. Restore assigns fresh local IDs and retains provenance. The app still accepts archives in formats 1.0 and 1.1.

## Rollout

Apply additive migration `0013_item_labels.sql` before pushing an approved deployment. No new storage rules or provider configuration are required. Check selection, clearing and conflict comparison from two member accounts, then inspect both PDFs and restore a disposable archive. After members start using labels, prefer fixing forward: older app versions would omit them from exports and cannot restore format 1.2 archives.
