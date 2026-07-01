import type { Lead, SuppressionEntry } from "../types";
import { storage } from "./storage";
import { nanoid } from "../utils/nanoid";

/**
 * Compliance Layer
 * CASL-aware suppression checking, unsubscribe handling, audit logging.
 *
 * All functions are now async — they hit Supabase instead of localStorage.
 */

// ─── Suppression checks ───────────────────────────────────────────────────────

export async function isSuppressed(email: string): Promise<boolean> {
  const list = await storage.get<SuppressionEntry>(storage.KEYS.suppression);
  return list.some((e) => e.emailAddress.toLowerCase() === email.toLowerCase());
}

export async function filterSuppressedLeads(
  leads: Lead[]
): Promise<{ clean: Lead[]; suppressed: Lead[] }> {
  const list = await storage.get<SuppressionEntry>(storage.KEYS.suppression);
  const suppressedEmails = new Set(list.map((e) => e.emailAddress.toLowerCase()));

  const clean: Lead[] = [];
  const suppressed: Lead[] = [];

  for (const lead of leads) {
    if (suppressedEmails.has(lead.contactEmail.toLowerCase())) {
      suppressed.push({ ...lead, suppressed: true, status: "suppressed" });
    } else {
      clean.push(lead);
    }
  }

  return { clean, suppressed };
}

// ─── Add to suppression list ──────────────────────────────────────────────────

export async function addToSuppressionList(
  email: string,
  reason: SuppressionEntry["reason"],
  campaignId?: string
): Promise<void> {
  if (await isSuppressed(email)) return; // already there

  const entry: SuppressionEntry = {
    id: nanoid(),
    emailAddress: email.toLowerCase(),
    reason,
    addedAt: new Date().toISOString(),
    sourceCampaignId: campaignId,
  };

  await storage.upsert(storage.KEYS.suppression, entry);

  // Also mark any leads with this email as suppressed
  const leads = await storage.get<Lead>(storage.KEYS.leads);
  const matches = leads.filter((l) => l.contactEmail.toLowerCase() === email.toLowerCase());

  await Promise.all(
    matches.map((lead) =>
      storage.upsert(storage.KEYS.leads, { ...lead, suppressed: true, status: "suppressed" })
    )
  );
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export async function logAudit(
  event: string,
  detail?: string,
  meta?: { inboxId?: string; leadId?: string; campaignId?: string }
): Promise<void> {
  const entry = {
    id: nanoid(),
    timestamp: new Date().toISOString(),
    event,
    detail,
    ...meta,
  };
  // Single insert — no need to read-modify-write the whole log anymore,
  // the DB orders by created_at for us.
  await storage.upsert(storage.KEYS.audit, entry);
}

