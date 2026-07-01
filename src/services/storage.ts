/**
 * Storage service — wraps Supabase with typed get/set/upsert/remove helpers.
 *
 * This replaces the old localStorage-backed version. The public API is
 * intentionally kept close to the original (same KEYS shape, same function
 * names) so callers only need to add `await`. The one new addition is
 * `subscribe()`, which lets pages auto-refresh when the *other* user
 * changes data — this is what makes the two of you share state live.
 *
 * Each table stores full records as JSONB under `payload`, keyed by the
 * same `id` the app already generates via nanoid().
 */

import { supabase } from "./supabaseClient";

const KEYS = {
  leads: "leads",
  emails: "generated_emails",
  inboxes: "inboxes",
  campaigns: "campaigns",
  queue: "queue_items",
  suppression: "suppression",
  audit: "audit_log",
} as const;

type TableName = (typeof KEYS)[keyof typeof KEYS];

function timestampColumn(table: TableName): "created_at" | "updated_at" {
  return table === KEYS.audit ? "created_at" : "updated_at";
}

async function get<T>(table: TableName): Promise<T[]> {
  const orderCol = timestampColumn(table);
  const pageSize = 1000; // Supabase/PostgREST's default max rows per request
  const allRows: T[] = [];
  let from = 0;

  // Page through in batches — a single request silently caps at 1000 rows
  // otherwise, which would quietly drop leads once you're importing at scale.
  //
  // Secondary sort on "id" matters: when many rows share the exact same
  // updated_at (e.g. a bulk CSV import), sorting on updated_at alone doesn't
  // give Postgres a stable order for ties, so the same row can appear on
  // two different pages. Adding "id" as a tiebreaker makes the order —
  // and therefore the pagination — deterministic.
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("payload")
      .order(orderCol, { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`storage.get(${table}) failed:`, error.message);
      break;
    }

    const rows = (data || []).map((row) => row.payload as T);
    allRows.push(...rows);

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

/** Splits an array into fixed-size chunks. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Replaces the entire table contents with `items` (mirrors old localStorage-array semantics). */
async function set<T extends { id: string }>(table: TableName, rawItems: T[]): Promise<void> {
  // Defensive dedupe: an upsert batch containing the same id twice fails
  // outright ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time"), so guarantee uniqueness here regardless of what the caller passed.
  const seen = new Set<string>();
  const items = rawItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const existingIds: string[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`storage.set(${table}) failed reading existing ids:`, error.message);
      return;
    }
    existingIds.push(...(data || []).map((r) => r.id as string));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  const newIds = new Set(items.map((i) => i.id));
  const toDelete = existingIds.filter((id) => !newIds.has(id));

  // Chunk deletes — a single `.in('id', [...])` call puts every id into the
  // request URL, and with thousands of ids that URL gets long enough to be
  // rejected outright (ERR_FAILED) before it even reaches Supabase.
  const DELETE_CHUNK = 200;
  for (const idBatch of chunk(toDelete, DELETE_CHUNK)) {
    const { error } = await supabase.from(table).delete().in("id", idBatch);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`storage.set(${table}) failed deleting stale rows:`, error.message);
    }
  }

  // Chunk upserts too — smaller batches are more resilient and easier to
  // debug than one giant request for a large table.
  const UPSERT_CHUNK = 500;
  const col = timestampColumn(table);
  const rows = items.map((item) => ({
    id: item.id,
    payload: item,
    [col]: new Date().toISOString(),
  }));

  for (const rowBatch of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await supabase.from(table).upsert(rowBatch);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`storage.set(${table}) failed upserting rows:`, error.message);
    }
  }
}

async function upsert<T extends { id: string }>(table: TableName, item: T): Promise<void> {
  const col = timestampColumn(table);
  const row = { id: item.id, payload: item, [col]: new Date().toISOString() };
  const { error } = await supabase.from(table).upsert(row);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`storage.upsert(${table}) failed:`, error.message);
  }
}

async function remove<T>(table: TableName, id: string): Promise<void> {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`storage.remove(${table}) failed:`, error.message);
  }
}

/**
 * Subscribes to any insert/update/delete on `table` and calls `onChange`.
 * Use this in a useEffect to auto-refresh a page when your partner changes
 * data from their own session. Returns an unsubscribe function.
 *
 * Debounced: Supabase Realtime fires one event PER ROW changed, so a bulk
 * operation (e.g. importing 50 leads at once) would otherwise trigger 50
 * near-simultaneous refetches and exhaust the browser's connection pool.
 * Rapid bursts of events within `debounceMs` collapse into a single
 * refetch instead.
 */
function subscribe(table: TableName, onChange: () => void, debounceMs = 400): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debouncedOnChange = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(onChange, debounceMs);
  };

  // Unique channel name per subscription avoids collisions if React's
  // StrictMode double-invokes effects during development.
  const channel = supabase
    .channel(`realtime:${table}:${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, debouncedOnChange)
    .subscribe();

  return () => {
    if (timeout) clearTimeout(timeout);
    supabase.removeChannel(channel);
  };
}

export const storage = { get, set, upsert, remove, subscribe, KEYS };