// Form encoding for providers whose API takes `application/x-www-form-urlencoded` (Stripe, Twilio), see ADR-019.
// Objects use bracket notation (`a[b]=c`). Arrays are either indexed (`a[0]=x`, Stripe) or repeated (`a=x&a=y`, Twilio).

export type FormArrays = "indices" | "repeat"

type Pair = [string, string]

function scalarText(value: unknown, path: string): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value)
  if (value instanceof Date) return value.toISOString()
  // null means "unset this field": providers that take form data (Stripe) clear a field when it is sent empty.
  if (value === null) return ""
  throw new TypeError(`"${path}" cannot be form-encoded.`)
}

function collect(value: unknown, path: string, arrays: FormArrays, out: Pair[], depth: number): void {
  if (value === undefined) return
  if (depth > 8) throw new TypeError(`"${path}" is nested too deeply to form-encode.`)
  if (Array.isArray(value)) {
    if (value.length === 0) return // there is no way to say "empty list" in a form; leaving it out is the closest
    value.forEach((item, index) => collect(item, arrays === "indices" ? `${path}[${index}]` : path, arrays, out, depth + 1))
    return
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) collect(item, `${path}[${key}]`, arrays, out, depth + 1)
    return
  }
  out.push([path, scalarText(value, path)])
}

/** Flatten an object into ordered name/value pairs. Undefined values are skipped. */
export function formPairs(input: Record<string, unknown>, arrays: FormArrays = "indices"): Pair[] {
  const out: Pair[] = []
  for (const [key, value] of Object.entries(input)) collect(value, key, arrays, out, 0)
  return out
}

/** `a[b]=c&d=e`, percent-encoded, as the body of a form request. */
export function encodeForm(input: Record<string, unknown>, arrays: FormArrays = "indices"): string {
  return formPairs(input, arrays)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&")
}
