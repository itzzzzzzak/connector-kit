/** One bounded page. `nextCursor: null` means there is nothing more to fetch. */
export interface PageEnvelope<Item> {
  items: Item[]
  nextCursor: string | null
}

/**
 * How ONE provider's pagination mechanics work. The kit ships ready-made strategies;
 * a connector picks one instead of re-implementing paging. See ADR-010 and ADR-015.
 */
export interface PaginationStrategy {
  /** The query param this provider uses to request a page size, e.g. "per_page" or "limit". Omit when it has none. */
  pageSizeParam?: string
  defaultPageSize: number
  maxPageSize: number
  /** Where the list is inside the response body. Omit when the body IS the list (GitHub). */
  items?(body: unknown): unknown
  /** Read the next cursor from a successful response. Null means "no more pages". */
  nextCursor(response: { headers: Headers; body: unknown }): string | null
  /**
   * Turn the request for the FIRST page (path filled, filters and page size set) into the request
   * for the page a cursor points to. A Link-header API replaces the whole URL (the cursor IS the
   * next URL); a body-cursor API adds one query parameter.
   */
  applyCursor(url: URL, cursor: string): URL
}

/** GitHub-style: pages are described by a `Link: <url>; rel="next"` response header. */
export function linkHeaderPagination(options: {
  defaultPageSize?: number
  maxPageSize?: number
  pageSizeParam?: string
} = {}): PaginationStrategy {
  return {
    pageSizeParam: options.pageSizeParam ?? "per_page",
    defaultPageSize: options.defaultPageSize ?? 30,
    maxPageSize: options.maxPageSize ?? 100,
    nextCursor({ headers }) {
      const link = headers.get("link")
      if (!link) return null
      for (const part of link.split(",")) {
        const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
        if (match) return match[1]!
      }
      return null
    },
    applyCursor(_url, cursor) {
      return new URL(cursor)
    },
  }
}

const dig = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined), value)

/**
 * Slack/Stripe-style: the list is a field of the response body and the next cursor is another field
 * (empty or missing when finished); the cursor is sent back as one query parameter.
 */
export function bodyCursorPagination(options: {
  /** Key of the list in the response body, e.g. "channels". */
  itemsKey: string
  /** Path to the next cursor in the response body, e.g. ["response_metadata", "next_cursor"]. */
  cursorPath: string[]
  /** Query param that carries the cursor back. Default "cursor". */
  cursorParam?: string
  /** Default "limit". Pass `null` for an endpoint that has no page-size parameter. */
  pageSizeParam?: string | null
  defaultPageSize?: number
  maxPageSize?: number
}): PaginationStrategy {
  const cursorParam = options.cursorParam ?? "cursor"
  return {
    ...(options.pageSizeParam === null ? {} : { pageSizeParam: options.pageSizeParam ?? "limit" }),
    defaultPageSize: options.defaultPageSize ?? 30,
    maxPageSize: options.maxPageSize ?? 200,
    items: (body) => dig(body, [options.itemsKey]),
    nextCursor({ body }) {
      const cursor = dig(body, options.cursorPath)
      // Some providers (Vercel: a millisecond timestamp) use a number. Cursors stay opaque strings for callers.
      if (typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0) return String(cursor)
      return typeof cursor === "string" && cursor !== "" ? cursor : null
    },
    applyCursor(url, cursor) {
      const next = new URL(url)
      next.searchParams.set(cursorParam, cursor)
      return next
    },
  }
}

/**
 * DigitalOcean/Zendesk-style: the list is a field of the body and the body also carries the FULL URL of
 * the next page (`links.pages.next`); there is no separate cursor parameter. The URL is the cursor.
 */
export function bodyLinkPagination(options: {
  /** Key of the list in the response body, e.g. "droplets". */
  itemsKey: string
  /** Path to the next-page URL in the response body, e.g. ["links", "pages", "next"]. */
  nextUrlPath: string[]
  pageSizeParam?: string
  defaultPageSize?: number
  maxPageSize?: number
}): PaginationStrategy {
  return {
    pageSizeParam: options.pageSizeParam ?? "per_page",
    defaultPageSize: options.defaultPageSize ?? 30,
    maxPageSize: options.maxPageSize ?? 100,
    items: (body) => dig(body, [options.itemsKey]),
    nextCursor({ body }) {
      const next = dig(body, options.nextUrlPath)
      return typeof next === "string" && next !== "" ? next : null
    },
    applyCursor(_url, cursor) {
      return new URL(cursor)
    },
  }
}
