# Collection search (#22)

Members search saved item names, short descriptions and story text from **Belongings** in a private family collection. Each result identifies a draft or complete item, links to the current record and uses the existing membership-authorized retained thumbnail. Description and story matches show a short excerpt. Nothing searches across collections.

## Matching and pagination

- Search is a literal substring in a single field, with outer whitespace trimmed and SQLite's ASCII case folding. Non-ASCII text is matched as stored; there is no accent folding, tokenization, stemming, typo correction or wildcard syntax. Queries are capped at 120 UTF-16 code units.
- One hit per item. Name matches come first, then description, then story. Within each group, newest captured items come first, with item ID as the stable tie-breaker. If multiple stories match, the earliest recorded match provides the excerpt.
- Pages have up to 24 items. The database returns one extra row to detect another page, without counting all results. At most 100 pages are available; a narrower query can find later matches. Edits between pages can shift results. A new search starts on page one.
- The request reads current rows, so saved changes appear on the next search without indexing jobs. The database checks membership and scopes the item candidates before matching or returning excerpts. Items with no retained photo are excluded, consistent with normal browsing. When #27 lands, apply its current-item and current-story removal predicates here and add browser regression coverage.
- This uses the existing database and its collection/item relationship indexes. Substring matching scans eligible text within that collection; the intended pilot scale is about 100–1,000 items. Measure hosted latency before considering a search index or separate service. No schema, provider, backup or preservation format changes are needed.
- The search response is private/no-store and sends no referrer. The query is in the URL for pagination and can remain in browser history or infrastructure request logs; don't share that URL if its phrase is sensitive. The app does not persist search terms or provide suggestions.

## Hosted acceptance

After deployment, search a disposable collection for text exclusive to a name, a description and a story (including one on an untitled draft). Check that thumbnails load for members, links open the right item and saved changes appear without delay. Check blank/no-match and pagination states. An unrelated signed-in account or a removed member should be unable to open the search or acquire a new thumbnail grant.
