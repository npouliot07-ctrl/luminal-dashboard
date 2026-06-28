/**
 * Storage service — wraps localStorage with typed get/set/update helpers.
 * In production you'd replace this with your Base44 database calls.
 * All keys are namespaced under "od_" (outreach dashboard).
 */

const KEYS = {
  leads: "od_leads",
  emails: "od_emails",
  inboxes: "od_inboxes",
  campaigns: "od_campaigns",
  queue: "od_queue",
  suppression: "od_suppression",
  audit: "od_audit",
} as const;

function get<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function set<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

function upsert<T extends { id: string }>(key: string, item: T): void {
  const existing = get<T>(key);
  const idx = existing.findIndex((x) => x.id === item.id);
  if (idx >= 0) existing[idx] = item;
  else existing.push(item);
  set(key, existing);
}

function remove<T extends { id: string }>(key: string, id: string): void {
  const existing = get<T>(key);
  set(key, existing.filter((x) => x.id !== id));
}

export const storage = { get, set, upsert, remove, KEYS };
