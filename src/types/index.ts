// ─── LEADS ───────────────────────────────────────────────────────────────────

export type LeadStatus =
  | "new"
  | "generating"
  | "generated"
  | "approved"
  | "drafted"
  | "scheduled"
  | "sent"
  | "bounced"
  | "unsubscribed"
  | "suppressed";

export interface Lead {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  websiteUrl: string;
  language: string;
  sourceFile: string;
  status: LeadStatus;
  suppressed: boolean;
  createdAt: string;
}

// ─── GENERATED EMAILS ────────────────────────────────────────────────────────

export interface GeneratedEmail {
  id: string;
  leadId: string;
  subjectLine: string;
  body: string; // HTML with paragraph tags
  generatedAt: string;
  editedAt?: string;
  approved: boolean;
}

// ─── INBOXES ─────────────────────────────────────────────────────────────────

export interface Inbox {
  id: string;
  emailAddress: string;
  displayName: string;
  msAccountId: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  dailyLimit: number;       // current ceiling (starts at 5, ramps up)
  rampRate: number;         // +0.5 per day default, editable per inbox
  draftsToday: number;      // resets at midnight
  isActive: boolean;
  addedAt: string;
  lastRampedAt: string;
  lastMailCheckedAt?: string; // cursor for incoming-mail polling
}

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "active" | "paused" | "complete";
export type SchedulingMode = "auto" | "manual";

export interface Campaign {
  id: string;
  name: string;
  totalLeads: number;
  status: CampaignStatus;
  schedulingMode: SchedulingMode;
  gapMinutes: number;       // time between sends
  createdAt: string;
  launchedAt?: string;
}

// ─── QUEUE ───────────────────────────────────────────────────────────────────

export type QueueItemStatus =
  | "pending"
  | "drafted"
  | "scheduled"
  | "sent"
  | "failed";

export interface QueueItem {
  id: string;
  campaignId: string;
  leadId: string;
  emailId: string;
  inboxId: string;
  draftId?: string;         // Graph API draft message ID
  scheduledSendAt?: string;
  actualSentAt?: string;
  status: QueueItemStatus;
}

// ─── SUPPRESSION ─────────────────────────────────────────────────────────────

export type SuppressionReason = "unsubscribed" | "bounced" | "manual";

export interface SuppressionEntry {
  id: string;
  emailAddress: string;
  reason: SuppressionReason;
  addedAt: string;
  sourceCampaignId?: string;
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  event: string;
  inboxId?: string;
  leadId?: string;
  campaignId?: string;
  detail?: string;
}

// ─── INCOMING MAIL ─────────────────────────────────────────────────────────────
//
// Read-only records of mail received in a connected inbox — fetched via the
// Microsoft Graph API on your own account, nothing embedded in outgoing
// emails, no effect on deliverability. Not "tracking" in the sense of open
// pixels / link tracking / bounce webhooks — just reading your own mailbox.

export interface IncomingMail {
  id: string;              // Graph message id — naturally dedupes
  inboxId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  preview: string;
  receivedAt: string;
  matchedLeadId?: string;
  read: boolean;
}