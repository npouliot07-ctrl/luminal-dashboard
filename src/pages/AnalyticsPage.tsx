import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Mail, Send, CheckCircle2, Megaphone, Users, Download, Inbox as InboxIcon,
  Activity, FileEdit, TrendingUp, Trash2,
} from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from "recharts";
import type { Lead, GeneratedEmail, Campaign, QueueItem, Inbox, AuditEntry } from "../types";
import { storage } from "../services/storage";
import { getAvailableSlots } from "../services/routingEngine";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

/**
 * Analytics dashboard — built entirely from data this app already generates
 * internally (leads, generated emails, campaigns, queue items, inboxes,
 * audit log). Deliberately contains NO email tracking of any kind: no open
 * pixels, no reply/bounce/link tracking, no external services. Everything
 * here is a read-only aggregation of your own database rows.
 */

type DateRange = "7" | "30" | "90" | "all";

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function daysAgo(n: number): Date {
  return startOfDay(new Date(Date.now() - n * 86400000));
}

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function formatDayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Builds a zero-filled daily series between startDate and today (capped at 365 points). */
function buildDailySeries(isoDates: string[], startDate: Date): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const iso of isoDates) {
    const d = new Date(iso);
    if (d < startDate) continue;
    const key = dayKey(iso);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const result: { label: string; count: number }[] = [];
  const cursor = new Date(startDate);
  const today = startOfDay(new Date());
  let guard = 0;
  while (cursor <= today && guard < 365) {
    const key = cursor.toISOString().slice(0, 10);
    result.push({ label: formatDayLabel(key), count: counts.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return result;
}

function rangeStartDate(range: DateRange, fallbackEarliest: Date): Date {
  if (range === "7") return daysAgo(6);
  if (range === "30") return daysAgo(29);
  if (range === "90") return daysAgo(89);
  // "all" — cap at 365 days back so the chart stays readable
  const capped = daysAgo(364);
  return fallbackEarliest > capped ? fallbackEarliest : capped;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AnalyticsPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [emails, setEmails] = useState<GeneratedEmail[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [dateRange, setDateRange] = useState<DateRange>("30");
  const [campaignFilter, setCampaignFilter] = useState<string>("all");

  const loadAll = useCallback(async () => {
    const [l, e, c, q, i, a] = await Promise.all([
      storage.get<Lead>(storage.KEYS.leads),
      storage.get<GeneratedEmail>(storage.KEYS.emails),
      storage.get<Campaign>(storage.KEYS.campaigns),
      storage.get<QueueItem>(storage.KEYS.queue),
      storage.get<Inbox>(storage.KEYS.inboxes),
      storage.get<AuditEntry>(storage.KEYS.audit),
    ]);
    setLeads(l);
    setEmails(e);
    setCampaigns(c);
    setQueue(q);
    setInboxes(i);
    setAudit(a);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const unsubs = [
      storage.subscribe(storage.KEYS.leads, loadAll),
      storage.subscribe(storage.KEYS.emails, loadAll),
      storage.subscribe(storage.KEYS.campaigns, loadAll),
      storage.subscribe(storage.KEYS.queue, loadAll),
      storage.subscribe(storage.KEYS.inboxes, loadAll),
      storage.subscribe(storage.KEYS.audit, loadAll),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadAll]);

  // ── Overview cards (always all-time / fixed windows — not affected by filters) ──

  const overview = useMemo(() => {
    const now = Date.now();
    const todayStart = startOfDay(new Date()).getTime();
    const weekStart = daysAgo(6).getTime();
    const monthStart = daysAgo(29).getTime();

    const sentItems = queue.filter((q) => q.status === "sent" && q.actualSentAt);
    const sentToday = sentItems.filter((q) => new Date(q.actualSentAt!).getTime() >= todayStart).length;
    const sentThisWeek = sentItems.filter((q) => new Date(q.actualSentAt!).getTime() >= weekStart).length;
    const sentThisMonth = sentItems.filter((q) => new Date(q.actualSentAt!).getTime() >= monthStart).length;

    return {
      totalGenerated: emails.length,
      totalDrafted: queue.filter((q) => !!q.draftId).length,
      totalApproved: emails.filter((e) => e.approved).length,
      totalSent: sentItems.length,
      totalCampaigns: campaigns.length,
      totalContacts: leads.length,
      sentToday,
      sentThisWeek,
      sentThisMonth,
    };
  }, [leads, emails, campaigns, queue]);

  // ── Date-range-filtered series ──

  const earliestEmailDate = useMemo(
    () => (emails.length ? new Date(Math.min(...emails.map((e) => new Date(e.generatedAt).getTime()))) : new Date()),
    [emails]
  );
  const earliestSentDate = useMemo(() => {
    const sent = queue.filter((q) => q.actualSentAt);
    return sent.length
      ? new Date(Math.min(...sent.map((q) => new Date(q.actualSentAt!).getTime())))
      : new Date();
  }, [queue]);

  const generationSeries = useMemo(() => {
    const start = rangeStartDate(dateRange, earliestEmailDate);
    const relevantEmails = campaignFilter === "all"
      ? emails
      : emails.filter((e) => {
          const q = queue.find((qi) => qi.emailId === e.id);
          return q?.campaignId === campaignFilter;
        });
    return buildDailySeries(relevantEmails.map((e) => e.generatedAt), start);
  }, [emails, queue, dateRange, campaignFilter, earliestEmailDate]);

  const sendingSeries = useMemo(() => {
    const start = rangeStartDate(dateRange, earliestSentDate);
    const relevantSent = queue.filter(
      (q) => q.status === "sent" && q.actualSentAt && (campaignFilter === "all" || q.campaignId === campaignFilter)
    );
    return buildDailySeries(relevantSent.map((q) => q.actualSentAt!), start);
  }, [queue, dateRange, campaignFilter, earliestSentDate]);

  // ── Sending capacity ──

  const capacity = useMemo(() => {
    const totalDailyLimit = inboxes.reduce((sum, i) => sum + Math.floor(i.dailyLimit), 0);
    const totalUsedToday = inboxes.reduce((sum, i) => sum + i.draftsToday, 0);
    const totalRemaining = inboxes.reduce((sum, i) => sum + getAvailableSlots(i), 0);
    return { totalDailyLimit, totalUsedToday, totalRemaining };
  }, [inboxes]);

  // ── Per-campaign summary ──

  const campaignRows = useMemo(() => {
    return campaigns
      .map((c) => {
        const items = queue.filter((q) => q.campaignId === c.id);
        return {
          campaign: c,
          contacts: c.totalLeads,
          drafted: items.filter((i) => !!i.draftId).length,
          scheduled: items.filter((i) => i.status === "drafted" || i.status === "scheduled" || i.status === "pending").length,
          sent: items.filter((i) => i.status === "sent").length,
        };
      })
      .filter((row) => campaignFilter === "all" || row.campaign.id === campaignFilter)
      .sort((a, b) => new Date(b.campaign.createdAt).getTime() - new Date(a.campaign.createdAt).getTime());
  }, [campaigns, queue, campaignFilter]);

  const avgGeneratedPerCampaign = campaigns.length > 0 ? Math.round(emails.length / campaigns.length) : 0;

  // ── Recent activity feed ──

  const activityRows = useMemo(() => {
    const start = rangeStartDate(dateRange, new Date());
    return audit
      .filter((a) => new Date(a.timestamp) >= start)
      .filter((a) => campaignFilter === "all" || a.campaignId === campaignFilter)
      .slice(0, 100);
  }, [audit, dateRange, campaignFilter]);

  const eventLabel = (event: string): string => {
    const map: Record<string, { en: string; fr: string }> = {
      emails_generated: { en: "Emails generated", fr: "Emails générés" },
      draft_created: { en: "Draft created", fr: "Brouillon créé" },
      email_sent: { en: "Email sent", fr: "Email envoyé" },
      campaign_created: { en: "Campaign created", fr: "Campagne créée" },
      email_approved: { en: "Email(s) approved", fr: "Email(s) approuvé(s)" },
    };
    return map[event]?.[lang] || event;
  };

  const eventIcon = (event: string) => {
    switch (event) {
      case "emails_generated": return <Mail size={14} />;
      case "draft_created": return <FileEdit size={14} />;
      case "email_sent": return <Send size={14} />;
      case "campaign_created": return <Megaphone size={14} />;
      case "email_approved": return <CheckCircle2 size={14} />;
      default: return <Activity size={14} />;
    }
  };

  const deleteCampaign = async (campaign: Campaign) => {
    const relatedCount = queue.filter((q) => q.campaignId === campaign.id).length;
    const confirmMsg = lang === "fr"
      ? `Supprimer la campagne "${campaign.name}" ? Cela supprimera aussi ${relatedCount} élément(s) de la file d'envoi associés. Les prospects et emails générés ne seront pas supprimés.`
      : `Delete campaign "${campaign.name}"? This will also remove ${relatedCount} associated send-queue item(s). Leads and generated emails themselves won't be deleted.`;
    if (!window.confirm(confirmMsg)) return;

    const relatedQueueItems = queue.filter((q) => q.campaignId === campaign.id);
    await Promise.all(relatedQueueItems.map((q) => storage.remove<QueueItem>(storage.KEYS.queue, q.id)));
    await storage.remove<Campaign>(storage.KEYS.campaigns, campaign.id);

    if (campaignFilter === campaign.id) setCampaignFilter("all");
    await loadAll();
  };

  const handleExport = () => {
    const rows: (string | number)[][] = [
      ["Campaign", "Created", "Status", "Contacts", "Drafted", "Scheduled/Pending", "Sent"],
      ...campaignRows.map((r) => [
        r.campaign.name,
        new Date(r.campaign.createdAt).toLocaleDateString(),
        r.campaign.status,
        r.contacts,
        r.drafted,
        r.scheduled,
        r.sent,
      ]),
    ];
    downloadCsv(`campaign-analytics-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1>{tr("analytics")}</h1>
        </div>
        <p className="text-muted">{lang === "fr" ? "Chargement…" : "Loading…"}</p>
      </div>
    );
  }

  const statusBadgeClass = (status: Campaign["status"]) => {
    switch (status) {
      case "active": return "badge-active";
      case "complete": return "badge-sent";
      case "paused": return "badge-paused";
      default: return "badge-drafted";
    }
  };

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1>{tr("analytics")}</h1>
          <p>
            {lang === "fr"
              ? "Vue d'ensemble de l'activité — aucun suivi d'email (pas de pixels, pas de suivi des liens/réponses/rebonds)."
              : "System activity overview — no email tracking of any kind (no pixels, no link/reply/bounce tracking)."}
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={handleExport}>
          <Download size={14} /> {lang === "fr" ? "Exporter en CSV" : "Export CSV"}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mt-4" style={{ marginBottom: "var(--sp-4)" }}>
        <select className="select" style={{ maxWidth: 180 }} value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRange)}>
          <option value="7">{lang === "fr" ? "7 derniers jours" : "Last 7 days"}</option>
          <option value="30">{lang === "fr" ? "30 derniers jours" : "Last 30 days"}</option>
          <option value="90">{lang === "fr" ? "90 derniers jours" : "Last 90 days"}</option>
          <option value="all">{lang === "fr" ? "Tout" : "All time"}</option>
        </select>
        <select className="select" style={{ maxWidth: 240 }} value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}>
          <option value="all">{lang === "fr" ? "Toutes les campagnes" : "All campaigns"}</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* 1. Overview cards */}
      <div className="analytics-grid">
        <StatCard icon={<Mail size={16} />} label={lang === "fr" ? "Emails générés" : "Emails Generated"} value={overview.totalGenerated} />
        <StatCard icon={<FileEdit size={16} />} label={lang === "fr" ? "Emails en brouillon" : "Emails Drafted"} value={overview.totalDrafted} />
        <StatCard icon={<CheckCircle2 size={16} />} label={lang === "fr" ? "Emails approuvés" : "Emails Approved"} value={overview.totalApproved} />
        <StatCard icon={<Send size={16} />} label={lang === "fr" ? "Emails envoyés" : "Emails Sent"} value={overview.totalSent} />
        <StatCard icon={<Megaphone size={16} />} label={lang === "fr" ? "Campagnes créées" : "Campaigns Created"} value={overview.totalCampaigns} />
        <StatCard icon={<Users size={16} />} label={lang === "fr" ? "Contacts importés" : "Contacts Imported"} value={overview.totalContacts} />
        <StatCard icon={<TrendingUp size={16} />} label={lang === "fr" ? "Envoyés aujourd'hui" : "Sent Today"} value={overview.sentToday} accent />
        <StatCard icon={<TrendingUp size={16} />} label={lang === "fr" ? "Envoyés cette semaine" : "Sent This Week"} value={overview.sentThisWeek} accent />
        <StatCard icon={<TrendingUp size={16} />} label={lang === "fr" ? "Envoyés ce mois" : "Sent This Month"} value={overview.sentThisMonth} accent />
      </div>

      {/* 2. Generation analytics */}
      <div className="card mt-6">
        <div className="card-header">
          <h2>{lang === "fr" ? "Génération d'emails" : "Email Generation"}</h2>
          <span className="text-muted text-sm">
            {lang === "fr" ? `Moy. ${avgGeneratedPerCampaign} / campagne` : `Avg ${avgGeneratedPerCampaign} / campaign`}
          </span>
        </div>
        <div style={{ width: "100%", height: 220, padding: "var(--sp-2) 0" }}>
          <ResponsiveContainer>
            <LineChart data={generationSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="var(--accent)" strokeWidth={2} dot={false} name={lang === "fr" ? "Générés" : "Generated"} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 3. Sending activity analytics */}
      <div className="card mt-6">
        <div className="card-header">
          <h2>{lang === "fr" ? "Activité d'envoi" : "Sending Activity"}</h2>
        </div>
        <div style={{ width: "100%", height: 220, padding: "var(--sp-2) 0" }}>
          <ResponsiveContainer>
            <BarChart data={sendingSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
              <Tooltip />
              <Bar dataKey="count" fill="var(--success)" radius={[3, 3, 0, 0]} name={lang === "fr" ? "Envoyés" : "Sent"} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="capacity-row">
          <div className="capacity-chip">
            <span className="capacity-value">{capacity.totalDailyLimit}</span>
            <span className="capacity-label">{lang === "fr" ? "Capacité quotidienne" : "Daily Capacity"}</span>
          </div>
          <div className="capacity-chip">
            <span className="capacity-value">{capacity.totalUsedToday}</span>
            <span className="capacity-label">{lang === "fr" ? "Utilisé aujourd'hui" : "Used Today"}</span>
          </div>
          <div className="capacity-chip">
            <span className="capacity-value" style={{ color: "var(--success)" }}>{capacity.totalRemaining}</span>
            <span className="capacity-label">{lang === "fr" ? "Restant" : "Remaining"}</span>
          </div>
        </div>
      </div>

      {/* 4. Campaign dashboard */}
      <div className="card mt-6">
        <div className="card-header">
          <h2>{lang === "fr" ? "Campagnes" : "Campaigns"}</h2>
        </div>
        {campaignRows.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{lang === "fr" ? "Nom" : "Name"}</th>
                  <th>{lang === "fr" ? "Créée" : "Created"}</th>
                  <th>{lang === "fr" ? "Contacts" : "Contacts"}</th>
                  <th>{lang === "fr" ? "Brouillons" : "Drafted"}</th>
                  <th>{lang === "fr" ? "En attente" : "Scheduled/Pending"}</th>
                  <th>{lang === "fr" ? "Envoyés" : "Sent"}</th>
                  <th>{lang === "fr" ? "Statut" : "Status"}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {campaignRows.map((r) => (
                  <tr key={r.campaign.id}>
                    <td style={{ fontWeight: 500 }}>{r.campaign.name}</td>
                    <td className="text-muted text-sm">{new Date(r.campaign.createdAt).toLocaleDateString()}</td>
                    <td>{r.contacts}</td>
                    <td>{r.drafted}</td>
                    <td>{r.scheduled}</td>
                    <td>{r.sent}</td>
                    <td><span className={`badge ${statusBadgeClass(r.campaign.status)}`}>{r.campaign.status}</span></td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => deleteCampaign(r.campaign)}
                        title={lang === "fr" ? "Supprimer la campagne" : "Delete campaign"}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <Megaphone size={32} />
            <p>{lang === "fr" ? "Aucune campagne pour l'instant." : "No campaigns yet."}</p>
          </div>
        )}
      </div>

      {/* 5. Inbox capacity detail */}
      <div className="card mt-6">
        <div className="card-header">
          <h2>{lang === "fr" ? "Capacité par boîte" : "Capacity by Inbox"}</h2>
        </div>
        {inboxes.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th><InboxIcon size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />{lang === "fr" ? "Boîte" : "Inbox"}</th>
                  <th>{lang === "fr" ? "Limite" : "Limit"}</th>
                  <th>{lang === "fr" ? "Utilisé" : "Used"}</th>
                  <th>{lang === "fr" ? "Restant" : "Remaining"}</th>
                </tr>
              </thead>
              <tbody>
                {inboxes.map((i) => (
                  <tr key={i.id}>
                    <td className="mono text-sm">{i.emailAddress}</td>
                    <td>{Math.floor(i.dailyLimit)}</td>
                    <td>{i.draftsToday}</td>
                    <td style={{ color: getAvailableSlots(i) === 0 ? "var(--danger)" : "var(--success)", fontWeight: 600 }}>
                      {getAvailableSlots(i)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <InboxIcon size={32} />
            <p>{lang === "fr" ? "Aucune boîte configurée." : "No inboxes configured."}</p>
          </div>
        )}
      </div>

      {/* 6. Recent activity feed */}
      <div className="card mt-6">
        <div className="card-header">
          <h2>{lang === "fr" ? "Activité récente" : "Recent Activity"}</h2>
        </div>
        {activityRows.length > 0 ? (
          <div className="activity-list">
            {activityRows.map((entry) => (
              <div key={entry.id} className="activity-row">
                <div className="activity-icon">{eventIcon(entry.event)}</div>
                <div className="activity-body">
                  <div className="activity-title">{eventLabel(entry.event)}</div>
                  {entry.detail && <div className="activity-detail text-muted text-sm">{entry.detail}</div>}
                </div>
                <div className="activity-time text-muted text-sm">
                  {new Date(entry.timestamp).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Activity size={32} />
            <p>{lang === "fr" ? "Aucune activité dans cette période." : "No activity in this range."}</p>
          </div>
        )}
      </div>

      <style>{`
        .analytics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: var(--sp-3);
        }
        .stat-card {
          display: flex;
          flex-direction: column;
          gap: var(--sp-2);
          padding: var(--sp-4);
          background: var(--bg-surface);
          border: 1px solid var(--border-light);
          border-radius: var(--radius-lg);
        }
        .stat-card--accent { border-color: rgba(0,180,216,0.25); }
        .stat-card-top { display: flex; align-items: center; gap: var(--sp-2); color: var(--text-muted); }
        .stat-card-value { font-size: 26px; font-weight: 700; color: var(--text-primary); line-height: 1; }
        .stat-card-label { font-size: 12px; color: var(--text-muted); }
        .capacity-row { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--border-light); }
        .capacity-chip { display: flex; flex-direction: column; align-items: center; flex: 1; padding: var(--sp-3); background: var(--bg-elevated); border-radius: var(--radius); }
        .capacity-value { font-size: 20px; font-weight: 700; color: var(--text-primary); }
        .capacity-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
        .activity-list { display: flex; flex-direction: column; }
        .activity-row { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) 0; border-bottom: 1px solid var(--border-light); }
        .activity-row:last-child { border-bottom: none; }
        .activity-icon { width: 28px; height: 28px; border-radius: 50%; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; color: var(--accent); flex-shrink: 0; }
        .activity-body { flex: 1; min-width: 0; }
        .activity-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
        .activity-detail { margin-top: 2px; }
        .activity-time { white-space: nowrap; font-size: 12px; }
      `}</style>
    </div>
  );
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat-card ${accent ? "stat-card--accent" : ""}`}>
      <div className="stat-card-top">
        {icon}
        <span className="stat-card-label">{label}</span>
      </div>
      <div className="stat-card-value">{value.toLocaleString()}</div>
    </div>
  );
}