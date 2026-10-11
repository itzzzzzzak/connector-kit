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
  nextCursor(response: { headers: Headers; body: unknown; /** The request URL this response answers (carries the current offset/page and page size). */ url: URL }): string | null
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
  /**
   * Path to a boolean in the body (e.g. ["meta", "has_more"]). When given, there is a next page ONLY if it is `true`,
   * for providers that keep sending a next link on the last page.
   */
  hasMorePath?: string[]
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
      if (options.hasMorePath && dig(body, options.hasMorePath) !== true) return null
      const next = dig(body, options.nextUrlPath)
      return typeof next === "string" && next !== "" ? next : null
    },
    applyCursor(_url, cursor) {
      return new URL(cursor)
    },
  }
}

/**
 * Offset or page-number paging (Jira-style `startAt`, PagerDuty `offset`, Mailchimp `offset`+`count`, ClickUp `page`).
 * The cursor is the NEXT offset (or page number), as an opaque string. The current position and page size are read from
 * the request URL, so the strategy needs nothing but a rule for "is there more?". The first rule that applies wins:
 *   hasMorePath (a boolean that is true when more exist)  ->  lastPagePath (a boolean true on the last page)
 *   ->  totalPath (a total count)  ->  otherwise "the page came back full". An EMPTY page always ends paging.
 */
export function offsetPagination(options: {
  /** Key of the list in the body; omit when the body IS the list. */
  itemsKey?: string
  /** "offset" (default): the cursor counts items. "page": it counts pages. */
  unit?: "offset" | "page"
  /** Query parameter carrying the position. Default "offset" (or "page" for unit "page"). */
  positionParam?: string
  /** Query parameter for the page size. Default "limit". `null` for an endpoint with a fixed page size. */
  pageSizeParam?: string | null
  /** First page number when unit is "page". Default 1 (ClickUp uses 0). */
  firstPage?: number
  hasMorePath?: string[]
  lastPagePath?: string[]
  totalPath?: string[]
  defaultPageSize?: number
  maxPageSize?: number
}): PaginationStrategy {
  const unit = options.unit ?? "offset"
  const positionParam = options.positionParam ?? (unit === "page" ? "page" : "offset")
  const firstPage = options.firstPage ?? 1
  const sizeParam = options.pageSizeParam === null ? undefined : (options.pageSizeParam ?? "limit")

  return {
    ...(sizeParam !== undefined && { pageSizeParam: sizeParam }),
    defaultPageSize: options.defaultPageSize ?? 30,
    maxPageSize: options.maxPageSize ?? 100,
    ...(options.itemsKey !== undefined && { items: (body) => dig(body, [options.itemsKey!]) }),
    nextCursor({ body, url }) {
      const items = options.itemsKey !== undefined ? dig(body, [options.itemsKey]) : body
      if (!Array.isArray(items) || items.length === 0) return null // an empty page always ends paging

      const requested = sizeParam !== undefined ? Number(url.searchParams.get(sizeParam)) : Number.NaN
      const size = Number.isFinite(requested) && requested > 0 ? requested : items.length
      const raw = url.searchParams.get(positionParam)
      const position = raw === null ? (unit === "page" ? firstPage : 0) : Number(raw)
      if (!Number.isFinite(position) || position < 0) return null

      let more: boolean
      const hasMore = options.hasMorePath ? dig(body, options.hasMorePath) : undefined
      const lastPage = options.lastPagePath ? dig(body, options.lastPagePath) : undefined
      const total = options.totalPath ? dig(body, options.totalPath) : undefined
      if (typeof hasMore === "boolean") more = hasMore
      else if (typeof lastPage === "boolean") more = !lastPage
      else if (typeof total === "number" && Number.isFinite(total)) more = unit === "page" ? (position - firstPage + 1) * size < total : position + size < total
      else more = items.length >= size

      if (!more) return null
      return String(unit === "page" ? position + 1 : position + size)
    },
    applyCursor(url, cursor) {
      const next = new URL(url)
      next.searchParams.set(positionParam, cursor)
      return next
    },
  }
}

/**
 * Sentry-style: the next cursor travels in the Link header, as an attribute of the rel="next" entry
 * (`<url>; rel="next"; results="true"; cursor="0:100:0"`), and `results="false"` marks the last page.
 * The cursor is sent back as a query parameter on OUR request; the URL inside the header is never followed.
 */
export function linkHeaderCursorPagination(options: {
  cursorParam?: string
  pageSizeParam?: string | null
  defaultPageSize?: number
  maxPageSize?: number
} = {}): PaginationStrategy {
  const cursorParam = options.cursorParam ?? "cursor"
  return {
    ...(options.pageSizeParam === null ? {} : { pageSizeParam: options.pageSizeParam ?? "per_page" }),
    defaultPageSize: options.defaultPageSize ?? 30,
    maxPageSize: options.maxPageSize ?? 100,
    nextCursor({ headers }) {
      const link = headers.get("link")
      if (!link) return null
      for (const entry of link.split(/,\s*(?=<)/)) {
        const attributes = Object.fromEntries([...entry.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]))
        if (attributes.rel !== "next") continue
        if (attributes.results === "false") return null
        return attributes.cursor !== undefined && attributes.cursor !== "" ? attributes.cursor : null
      }
      return null
    },
    applyCursor(url, cursor) {
      const next = new URL(url)
      next.searchParams.set(cursorParam, cursor)
      return next
    },
  }
}
