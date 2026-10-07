/** One bounded page. `nextCursor: null` means there is nothing more to fetch. */
export interface PageEnvelope<Item> {
  items: Item[]
  nextCursor: string | null
}

/**
 * How ONE provider's pagination mechanics work. The kit ships ready-made strategies;
 * a connector picks one instead of re-implementing paging. See ADR-010.
 */
export interface PaginationStrategy {
  /** The query param this provider uses to request a page size, e.g. "per_page". */
  pageSizeParam: string
  defaultPageSize: number
  maxPageSize: number
  /** Read the next cursor from a successful response. Null means "no more pages". */
  nextCursor(response: { headers: Headers }): string | null
  /**
   * Turn a previously returned cursor back into a request URL.
   * For a Link-header style API, the cursor IS the full next-page URL.
   */
  urlForCursor(cursor: string): URL
}

/** GitHub-style: pages are described by a `Link: <url>; rel="next"` response header. */
export function linkHeaderPagination(options: {
  defaultPageSize?: number
  maxPageSize?: number
  pageSizeParam?: string
} = {}): PaginationStrategy {
  const defaultPageSize = options.defaultPageSize ?? 30
  const maxPageSize = options.maxPageSize ?? 100
  const pageSizeParam = options.pageSizeParam ?? "per_page"

  return {
    pageSizeParam,
    defaultPageSize,
    maxPageSize,
    nextCursor({ headers }) {
      const link = headers.get("link")
      if (!link) return null
      for (const part of link.split(",")) {
        const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
        if (match) return match[1]!
      }
      return null
    },
    urlForCursor(cursor) {
      return new URL(cursor)
    },
  }
}
