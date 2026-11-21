import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { searchCollection } from "@/server/collection-search";
import { SEARCH_FILTERS, SEARCH_PAGE_LIMIT, SEARCH_QUERY_LIMIT, emptySearchFilters, searchFilterKeys, type SearchFilter } from "@/shared/collection-search";
import SearchForm from "./search-form";

type SearchParams = Partial<Record<"q" | "page" | SearchFilter, string | string[]>>;

export default async function CollectionSearch({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const paramsInput = await searchParams;
  const { q, page: requestedPage } = paramsInput;
  const filters = { ...emptySearchFilters };
  const malformed = searchFilterKeys.filter(key => {
    const value = paramsInput[key];
    if (value === undefined || value === "") return false;
    if (typeof value !== "string" || value.length > 128 || /[^a-zA-Z0-9_-]/.test(value)) return true;
    if (key === "status" && value !== "draft" && value !== "complete") return true;
    filters[key] = value;
    return false;
  });
  const hasFilters = searchFilterKeys.some(key => filters[key] !== "");
  const query = typeof q === "string" && q.length <= SEARCH_QUERY_LIMIT && !q.includes("\0") ? q.trim() : "";
  const validQuery = q === undefined || typeof q === "string" && q.length <= SEARCH_QUERY_LIMIT && !q.includes("\0");
  const page = typeof requestedPage === "string" && /^[1-9]\d{0,2}$/.test(requestedPage) ? Number(requestedPage) : 1;
  const validPage = requestedPage === undefined || requestedPage === String(page) && page <= SEARCH_PAGE_LIMIT;
  const showResults = q === undefined || !!query || hasFilters;
  const results = await searchCollection(account.id, id, query, validPage ? page : 1, filters, showResults && validPage && validQuery && malformed.length === 0);
  if (!results) notFound();
  const invalidFilters = [...new Set([...malformed, ...results.unavailable])];
  const visibleFilters = { ...filters };
  for (const key of invalidFilters) visibleFilters[key] = "";
  const collectionPath = `/collections/${id}`;
  const pageHref = (number: number, clear = false) => {
    const values = new URLSearchParams();
    if (query) values.set("q", query);
    if (number > 1) values.set("page", String(number));
    if (!clear) for (const key of searchFilterKeys) if (visibleFilters[key]) values.set(key, visibleFilters[key]);
    return `${collectionPath}/search${values.size ? `?${values}` : ""}`;
  };
  return <>
    <p><a href={collectionPath}>← Back to collection</a></p>
    <p className="eyebrow">Private family collection</p>
    <h1>Search belongings</h1>
    <p className="intro">{results.collectionName}</p>
    <section className="card">
      <SearchForm collectionPath={collectionPath} query={query} choices={results.options} filters={visibleFilters} />
      {(hasFilters || invalidFilters.length > 0) && <p><a href={pageHref(1, true)}>Clear filters</a></p>}
    </section>
    {!validQuery ? <p role="alert">Enter one search phrase of up to {SEARCH_QUERY_LIMIT} characters.</p> :
      !validPage ? <p role="alert">That results page is unavailable. <a href={pageHref(1)}>Start at the first page</a>.</p> :
      invalidFilters.length > 0 ? <p role="alert">Unavailable filters: {invalidFilters.map(key => SEARCH_FILTERS[key]).join(", ")}. Choose available filters and search again, or clear filters.</p> :
      !showResults ? <p>Enter a word or phrase to find a belonging. <a href={pageHref(1, true)}>Browse all belongings</a>.</p> :
      <section className="card" aria-labelledby="search-results-heading">
        <h2 id="search-results-heading">Search results</h2>
        <p>{results.total} {results.total === 1 ? "belonging" : "belongings"}</p>
        {results.items.length === 0 ? <p>{page > 1 ? "No results on this page. Earlier pages may still have matches." : hasFilters ? "No belongings match these filters." : query ? "No belongings match that search." : "No saved belongings yet."}</p> :
        <ul className="draft-grid">{results.items.map(item => {
          const path = `${collectionPath}/items/${item.id}`;
          return <li key={item.id}>
            <a href={path}>
              <img src={`${path}/photo?size=thumbnail`} alt={`Photo of ${item.name || "an untitled belonging"}`} loading="lazy" width={240} height={240} />
              <span>{item.name || "Untitled belonging"} — {item.draft ? "Draft item" : "Complete item"}</span>
            </a>
            {item.field && <p className="story-text"><strong>Match: {item.field}</strong>{item.excerpt && <><br />{item.excerpt}</>}</p>}
          </li>;
        })}</ul>}
        {(page > 1 || results.hasNext) && <nav aria-label="Search result pages">
          <p>Page {page}</p>
          {page > 1 && <a href={pageHref(page - 1)}>Previous results</a>}
          {page > 1 && results.hasNext && page < SEARCH_PAGE_LIMIT && " · "}
          {results.hasNext && page < SEARCH_PAGE_LIMIT && <a href={pageHref(page + 1)}>Next results</a>}
          {results.hasNext && page === SEARCH_PAGE_LIMIT && <p>Narrow the search to see more matches.</p>}
        </nav>}
      </section>}
  </>;
}
