import { SEARCH_FILTERS, SEARCH_QUERY_LIMIT, searchFilterKeys, type SearchChoices, type SearchFilters } from "@/shared/collection-search";

export default function SearchForm({ collectionPath, query = "", choices, filters }: { collectionPath: string; query?: string; choices?: SearchChoices; filters?: SearchFilters }) {
  return <form action={`${collectionPath}/search`} method="get" role="search">
    <label htmlFor="collection-search-query">Search this collection</label>
    <input id="collection-search-query" type="search" name="q" defaultValue={query} maxLength={SEARCH_QUERY_LIMIT} autoComplete="off" aria-describedby="collection-search-help" />
    <p id="collection-search-help" className="hint">Search saved item names, descriptions, and stories.</p>
    {choices && filters && <fieldset className="item-fields">
      <legend>Filter belongings</legend>
      {searchFilterKeys.map(key => <div key={key}>
        <label htmlFor={`filter-${key}`}>{SEARCH_FILTERS[key]}</label>
        <select id={`filter-${key}`} name={key} defaultValue={filters[key]}>
          <option value="">Any</option>
          {key !== "status" && <option value="unassigned">Not assigned</option>}
          {choices[key].map(choice => <option key={choice.id} value={choice.id}>{choice.name}{choice.note ? ` — ${choice.note}` : ""}</option>)}
        </select>
      </div>)}
    </fieldset>}
    <button type="submit">Search belongings</button>
  </form>;
}
