import type { Inbox, Lead, QueueItem, Campaign } from "../types";
import { storage } from "./storage";
import { nanoid } from "../utils/nanoid";

/**
 * Routing Engine
 *
 * 1. Filters inboxes to those with available slots today
 * 2. Distributes leads proportionally by available capacity
 * 3. Builds QueueItems with scheduled send times
 *
 * NOTE: distributeLeads/buildQueueItems/getAvailableSlots are pure
 * functions with no storage calls, so they're unchanged by the Supabase
 * migration. (The inbox-distribution bug is a separate, already-identified
 * issue — see the note in CampaignPage.tsx / the handoff conversation.)
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

export async function applyDailyRamp(): Promise<void> {
  const inboxes = await storage.get<Inbox>(storage.KEYS.inboxes);
  const today = new Date().toDateString();

  const toRamp = inboxes.filter(
    (inbox) => new Date(inbox.lastRampedAt).toDateString() !== today
  );

  await Promise.all(
    toRamp.map((inbox) =>
      storage.upsert(storage.KEYS.inboxes, {
        ...inbox,
        dailyLimit: inbox.dailyLimit + inbox.rampRate,
        draftsToday: 0,
        lastRampedAt: new Date().toISOString(),
      })
    )
  );
}
