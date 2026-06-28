import type { Lead, SuppressionEntry } from "../types";
import { storage } from "./storage";
import { nanoid } from "../utils/nanoid";

/**
 * Compliance Layer
 * CASL-aware suppression checking, unsubscribe handling, audit logging.
 */

// ─── Suppression checks ───────────────────────────────────────────────────────

export function isSupprressed(email: string): boolean {
  const list = storage.get<SuppressionEntry>(storage.KEYS.suppression);
  return list.some(
    (e) => e.emailAddress.toLowerCase() === email.toLowerCase()
  );
}

export function filterSuppressedLeads(leads: Lead[]): {
  clean: Lead[];
  suppressed: Lead[];
} {
  const clean: Lead[] = [];
  const suppressed: Lead[] = [];

  for (const lead of leads) {
    if (isSupprressed(lead.contactEmail)) {
      suppressed.push({ ...lead, suppressed: true, status: "suppressed" });
    } else {
      clean.push(lead);
    }
  }

  return { clean, suppressed };
}

// ─── Add to suppression list ──────────────────────────────────────────────────

export function addToSuppressionList(
  email: string,
  reason: SuppressionEntry["reason"],
  campaignId?: string
): void {
  if (isSupprressed(email)) return; // already there

  const entry: SuppressionEntry = {
    id: nanoid(),
    emailAddress: email.toLowerCase(),
    reason,
    addedAt: new Date().toISOString(),
    sourceCampaignId: campaignId,
  };

  storage.upsert(storage.KEYS.suppression, entry);

  // Also mark any leads with this email as suppressed
  const leads = storage.get<Lead>(storage.KEYS.leads);
  for (const lead of leads) {
    if (lead.contactEmail.toLowerCase() === email.toLowerCase()) {
      storage.upsert(storage.KEYS.leads, {
        ...lead,
        suppressed: true,
        status: "suppressed",
      });
    }
  }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export function logAudit(
  event: string,
  detail?: string,
  meta?: { inboxId?: string; leadId?: string; campaignId?: string }
): void {
  const entry = {
    id: nanoid(),
    timestamp: new Date().toISOString(),
    event,
    detail,
    ...meta,
  };
  const log = storage.get<typeof entry>(storage.KEYS.audit);
  log.unshift(entry); // newest first
  // Keep last 1000 entries
  storage.set(storage.KEYS.audit, log.slice(0, 1000));
}
