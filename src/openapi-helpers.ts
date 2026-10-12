// Small helpers used only by connectors generated from an official OpenAPI description (scripts/gen-openapi.mjs).
import { z } from "zod"

/**
 * `z.object` with the precise type thrown away. Generated connectors describe thousands of inputs; asking the compiler to work out
 * the exact type of each one (ADR-018) makes `tsc` run out of memory, and nothing reads those types: they are only ever used as schemas.
 */
export const obj: (shape: Record<string, z.ZodType>) => z.ZodType = z.object

/** Copy only the listed keys (those that are present) from an input object. */
export function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key]
  return out
}

/** Like `pick`, but also renames keys: { input_name: "wire_name" }. */
export function pickAs(input: Record<string, unknown>, map: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [from, to] of Object.entries(map)) if (input[from] !== undefined) out[to] = input[from]
  return out
}
