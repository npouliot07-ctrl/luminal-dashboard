import type { Inbox, Lead, QueueItem, Campaign } from "../types";
import { storage } from "./storage";
import { nanoid } from "../utils/nanoid";

/**
 * Routing Engine
 *
 * 1. Filters inboxes to those with available slots today
 * 2. Distributes leads proportionally by available capacity
 * 3. Builds QueueItems with scheduled send times
 */

// ─── Available slots per inbox ────────────────────────────────────────────────

export function getAvailableSlots(inbox: Inbox): number {
  return Math.max(0, Math.floor(inbox.dailyLimit) - inbox.draftsToday);
}

// ─── Weighted distribution ────────────────────────────────────────────────────

export function distributeLeads(
  leads: Lead[],
  inboxes: Inbox[]
): Map<string, Lead[]> {
  const activeInboxes = inboxes.filter(
    (i) => i.isActive && getAvailableSlots(i) > 0
  );

  if (activeInboxes.length === 0) return new Map();

  const totalSlots = activeInboxes.reduce(
    (sum, i) => sum + getAvailableSlots(i),
    0
  );

  // Assign leads to inboxes proportionally
  const distribution = new Map<string, Lead[]>();
  let leadIdx = 0;

  for (const inbox of activeInboxes) {
    const slots = getAvailableSlots(inbox);
    const share = Math.round((slots / totalSlots) * leads.length);
    const assigned = leads.slice(leadIdx, leadIdx + share);
    if (assigned.length > 0) distribution.set(inbox.id, assigned);
    leadIdx += share;
  }

  // Assign any remaining leads to the inbox with most capacity
  if (leadIdx < leads.length) {
    const largest = activeInboxes.reduce((a, b) =>
      getAvailableSlots(a) >= getAvailableSlots(b) ? a : b
    );
    const existing = distribution.get(largest.id) || [];
    distribution.set(largest.id, [...existing, ...leads.slice(leadIdx)]);
  }

  return distribution;
}

// ─── Build queue items with scheduled send times ──────────────────────────────

export function buildQueueItems(
  campaign: Campaign,
  emailIds: Map<string, string>, // leadId -> emailId
  distribution: Map<string, Lead[]>
): QueueItem[] {
  const items: QueueItem[] = [];
  let sendTime = new Date();

  for (const [inboxId, leads] of distribution.entries()) {
    for (const lead of leads) {
      const emailId = emailIds.get(lead.id) || "";
      items.push({
        id: nanoid(),
        campaignId: campaign.id,
        leadId: lead.id,
        emailId,
        inboxId,
        status: "pending",
        scheduledSendAt:
          campaign.schedulingMode === "auto"
            ? (() => {
                const t = new Date(sendTime);
                sendTime = new Date(
                  sendTime.getTime() + campaign.gapMinutes * 60 * 1000
                );
                return t.toISOString();
              })()
            : undefined,
      });
    }
  }

  return items;
}

// ─── Daily ramp — call once per day at midnight ───────────────────────────────

export function applyDailyRamp(): void {
  const inboxes = storage.get<Inbox>(storage.KEYS.inboxes);
  const today = new Date().toDateString();

  for (const inbox of inboxes) {
    const lastRamped = new Date(inbox.lastRampedAt).toDateString();
    if (lastRamped !== today) {
      inbox.dailyLimit = inbox.dailyLimit + inbox.rampRate;
      inbox.draftsToday = 0;
      inbox.lastRampedAt = new Date().toISOString();
      storage.upsert(storage.KEYS.inboxes, inbox);
    }
  }
}
