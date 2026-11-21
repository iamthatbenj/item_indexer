import { SEARCH_QUERY_LIMIT } from "@/shared/collection-search";

export default function SearchForm({ collectionPath, query = "" }: { collectionPath: string; query?: string }) {
  return <form action={`${collectionPath}/search`} method="get" role="search">
    <label htmlFor="collection-search-query">Search this collection</label>
    <input id="collection-search-query" type="search" name="q" defaultValue={query} maxLength={SEARCH_QUERY_LIMIT} autoComplete="off" aria-describedby="collection-search-help" />
    <p id="collection-search-help" className="hint">Search saved item names, descriptions, and stories.</p>
    <button type="submit">Search belongings</button>
  </form>;
}
