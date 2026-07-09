// Parse + schema-validate the session-title the summariser model returns, with a refetch on a bad
// reply. Server-side (zod stays out of the web bundle); the model is asked for JSON, so we validate
// the shape rather than scrub free text.
import { z } from "zod";

// The model is told to reply with {"title": "..."}. A real title is a short name, so the schema
// also rejects a sentence stuffed into the field — that fails validation and triggers a refetch.
const TitleSchema = z.object({
  title: z.string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .refine((s) => s.length >= 1 && s.length <= 48 && s.split(" ").length <= 6),
});

/** Pull a valid title out of one model reply, or null. Extracts the first `{…}` (tolerating
 *  ```fences / prose around it), JSON-parses it, and validates against the schema. */
export function titleFromModelJson(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*?\}/); // first JSON object, wherever the model buried it
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const result = TitleSchema.safeParse(parsed);
  if (!result.success) return null;
  const t = result.data.title;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Call the model up to `attempts` times, returning the first reply that yields a schema-valid
 *  title; null if none do (caller falls back to the prompt-derived title). Refetches because the
 *  model occasionally returns prose / an over-long title that fails validation. */
export async function retryTitle(fetchReply: () => Promise<string>, attempts = 2): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const title = titleFromModelJson(await fetchReply().catch(() => ""));
    if (title) return title;
  }
  return null;
}
