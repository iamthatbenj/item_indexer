export const SEARCH_QUERY_LIMIT = 120;
export const SEARCH_PAGE_SIZE = 24;
export const SEARCH_PAGE_LIMIT = 100;

export const SEARCH_FILTERS = { category: "Category", keeper: "Current keeper", location: "Location", status: "Draft status" } as const;
export type SearchFilter = keyof typeof SEARCH_FILTERS;
export type SearchFilters = Record<SearchFilter, string>;
export const searchFilterKeys = Object.keys(SEARCH_FILTERS) as SearchFilter[];
export const emptySearchFilters: SearchFilters = { category: "", keeper: "", location: "", status: "" };
export type SearchChoice = { id: string; name: string; note?: string };
export type SearchChoices = Record<SearchFilter, SearchChoice[]>;
