# Collection browsing and search filters (#23)

Open **Browse and filter belongings** from the collection, or use the filter controls on the search results page. Category, current keeper, location and draft status can be combined with one another and with a text phrase. **Any** does not limit results; **Not assigned** matches items missing that category, keeper or location. **Clear filters** keeps the search phrase and returns to the first page.

Results, filter choices and the exact matching-item count come from the same collection-membership-scoped database statement. Results include only items with a retained photo, rendered through the existing private thumbnail route. Pages contain up to 24 items and preserve the query and selected filters. On mobile, use browser Back after opening an item to return to the same result page. Search and filter URLs are not access grants.

Renames keep the same label choice. Merges move items to the active destination and remove the retired label from the choices. A stale, malformed or cross-collection filter produces an unavailable-filter message and no results or count until corrected or cleared. Keeper changes affect the next search. When #27 adds item/story removal, extend the shared result predicates and add coverage so results, excerpts and counts exclude removed records.

No migration, search service, or provider configuration is required. After deployment, verify the intersection of several filters and a story or name query, check missing values and clearing, then follow a result and go back on a phone. Confirm that a renamed label stays selectable and the retired label after a merge no longer works.
