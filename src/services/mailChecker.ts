import type { Inbox, Lead, IncomingMail } from "../types";
import { storage } from "./storage";
import { getValidAccessToken } from "./graphApi";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } };
}

async function fetchNewMessages(inbox: Inbox, accessToken: string): Promise<GraphMessage[]> {
  // First-ever check for an inbox looks back 24h; after that, only mail
  // received since the last successful check — so nothing is missed
  // across sessions, and nothing gets re-fetched repeatedly.
  const since = inbox.lastMailCheckedAt || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  const select = "id,subject,bodyPreview,receivedDateTime,from";
  const url = `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime desc&$top=50&$select=${select}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Graph API error ${res.status}`);
  }
  const data = await res.json();
  return data.value || [];
}

/**
 * Checks one connected inbox for mail received since the last check,
 * upserts everything found (idempotent — re-fetching the same message just
 * overwrites the same row), advances the inbox's cursor, and returns only
 * the messages that are genuinely new relative to `existingIds` — i.e. the
 * ones worth surfacing as a notification.
 */
export async function checkInboxForNewMail(
  inbox: Inbox,
  leads: Lead[],
  existingIds: Set<string>
): Promise<IncomingMail[]> {
  if (!inbox.refreshToken) return [];

  const accessToken = await getValidAccessToken(inbox);
  const messages = await fetchNewMessages(inbox, accessToken);

  const leadByEmail = new Map(leads.map((l) => [l.contactEmail.toLowerCase(), l]));

  const incoming: IncomingMail[] = messages.map((m) => {
    const fromEmail = (m.from?.emailAddress?.address || "").toLowerCase();
    const matchedLead = leadByEmail.get(fromEmail);
    return {
      id: m.id,
      inboxId: inbox.id,
      fromEmail,
      fromName: m.from?.emailAddress?.name || fromEmail || "Unknown",
      subject: m.subject || "(no subject)",
      preview: m.bodyPreview || "",
      receivedAt: m.receivedDateTime,
      matchedLeadId: matchedLead?.id,
      read: false,
    };
  });

  await Promise.all(incoming.map((msg) => storage.upsert(storage.KEYS.incomingMail, msg)));
  await storage.upsert(storage.KEYS.inboxes, { ...inbox, lastMailCheckedAt: new Date().toISOString() });

  return incoming.filter((m) => !existingIds.has(m.id));
}

/** Checks every connected inbox and returns all newly-found messages combined. */
export async function checkAllInboxesForMail(inboxes: Inbox[], leads: Lead[]): Promise<IncomingMail[]> {
  const connected = inboxes.filter((i) => i.refreshToken);
  if (connected.length === 0) return [];

  const existing = await storage.get<IncomingMail>(storage.KEYS.incomingMail);
  const existingIds = new Set(existing.map((m) => m.id));

  const results = await Promise.allSettled(
    connected.map((inbox) => checkInboxForNewMail(inbox, leads, existingIds))
  );

  const all: IncomingMail[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.error("Mail check failed for an inbox:", r.reason);
  }
  return all;
}