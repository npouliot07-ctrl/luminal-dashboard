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
  // Planning the split only needs an inbox to be marked active — it does NOT
  // need to be OAuth-connected yet. Whether a specific draft can actually be
  // created depends on the connection at draft-creation time (handled by the
  // caller), not here. This lets you pre-plan an even split across all your
  // inboxes and connect them incrementally, retrying each item once its
  // assigned inbox is connected — instead of everything piling onto whichever
  // single inbox happens to already have a token.
  const activeInboxes = inboxes.filter(
    (i) => i.isActive && getAvailableSlots(i) > 0
  );

  if (activeInboxes.length === 0) return new Map();

  // Round-robin allocation: one lead at a time, always to whichever inbox
  // currently has the most remaining room. This guarantees genuinely even
  // spread no matter the ratio of leads to inboxes.
  //
  // The old approach computed each inbox's proportional share and rounded
  // it — e.g. Math.round((5/64) * 4) = 0. When every inbox's share rounds
  // to zero (small batch, many inboxes), the entire batch fell through to
  // a "give the rest to whoever has the most capacity" fallback, which
  // dumped everything onto a single inbox instead of spreading it.
  // Round-robin has no such degenerate case: capacity only ever decreases
  // by whole leads, so it cycles through every eligible inbox in turn.
  const remaining = new Map(activeInboxes.map((i) => [i.id, getAvailableSlots(i)]));
  const distribution = new Map<string, Lead[]>();

  for (const lead of leads) {
    let bestId: string | null = null;
    let bestRemaining = 0;
    for (const [id, cap] of remaining.entries()) {
      if (cap > bestRemaining) {
        bestRemaining = cap;
        bestId = id;
      }
    }
    if (!bestId) break; // no capacity left anywhere

    remaining.set(bestId, remaining.get(bestId)! - 1);
    const existing = distribution.get(bestId) || [];
    distribution.set(bestId, [...existing, lead]);
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