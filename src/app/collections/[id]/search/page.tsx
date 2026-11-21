import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { searchCollection } from "@/server/collection-search";
import { SEARCH_PAGE_LIMIT, SEARCH_QUERY_LIMIT } from "@/shared/collection-search";
import SearchForm from "./search-form";

type SearchParams = { q?: string | string[]; page?: string | string[] };

export default async function CollectionSearch({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const { q, page: requestedPage } = await searchParams;
  const query = typeof q === "string" && q.length <= SEARCH_QUERY_LIMIT && !q.includes("\0") ? q.trim() : "";
  const validQuery = q === undefined || typeof q === "string" && q.length <= SEARCH_QUERY_LIMIT && !q.includes("\0");
  const page = typeof requestedPage === "string" && /^[1-9]\d{0,2}$/.test(requestedPage) ? Number(requestedPage) : 1;
  const validPage = requestedPage === undefined || requestedPage === String(page) && page <= SEARCH_PAGE_LIMIT;
  const results = await searchCollection(account.id, id, validPage ? query : "", validPage ? page : 1);
  if (!results) notFound();
  const collectionPath = `/collections/${id}`;
  const pageHref = (number: number) => `${collectionPath}/search?${new URLSearchParams({ q: query, page: String(number) })}`;
  return <>
    <p><a href={collectionPath}>← Back to collection</a></p>
    <p className="eyebrow">Private family collection</p>
    <h1>Search belongings</h1>
    <p className="intro">{results.collectionName}</p>
    <section className="card"><SearchForm collectionPath={collectionPath} query={query} /></section>
    {!validQuery ? <p role="alert">Enter one search phrase of up to {SEARCH_QUERY_LIMIT} characters.</p> :
      !validPage ? <p role="alert">That results page is unavailable. <a href={pageHref(1)}>Start at the first page</a>.</p> :
      !query ? <p>Enter a word or phrase to find a belonging.</p> :
      <section className="card" aria-labelledby="search-results-heading">
        <h2 id="search-results-heading">Search results</h2>
        {results.items.length === 0 ? <p>{page === 1 ? "No belongings match that search." : "No results on this page. Earlier pages may still have matches."}</p> :
        <ul className="draft-grid">{results.items.map(item => {
          const path = `${collectionPath}/items/${item.id}`;
          return <li key={item.id}>
            <a href={path}>
              <img src={`${path}/photo?size=thumbnail`} alt={`Photo of ${item.name || "an untitled belonging"}`} loading="lazy" width={240} height={240} />
              <span>{item.name || "Untitled belonging"} — {item.draft ? "Draft item" : "Complete item"}</span>
            </a>
            <p className="story-text"><strong>Match: {item.field}</strong>{item.excerpt && <><br />{item.excerpt}</>}</p>
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
