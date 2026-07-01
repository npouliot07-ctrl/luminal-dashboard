import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Send, RefreshCw, Clock } from "lucide-react";
import type { QueueItem, Lead, Inbox, Campaign } from "../types";
import { storage } from "../services/storage";
import { sendDraft } from "../services/graphApi";
import { logAudit } from "../services/compliance";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

export function QueuePage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoMode, setAutoMode] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const schedulerRef = useRef<NodeJS.Timeout | null>(null);

  const refreshQueue = useCallback(async () => {
    setQueue(await storage.get<QueueItem>(storage.KEYS.queue));
  }, []);
  const refreshLeads = useCallback(async () => {
    setLeads(await storage.get<Lead>(storage.KEYS.leads));
  }, []);
  const refreshInboxes = useCallback(async () => {
    setInboxes(await storage.get<Inbox>(storage.KEYS.inboxes));
  }, []);
  const refreshCampaigns = useCallback(async () => {
    setCampaigns(await storage.get<Campaign>(storage.KEYS.campaigns));
  }, []);

  // Initial load + live sync so both users see the queue update together
  useEffect(() => {
    (async () => {
      await Promise.all([refreshQueue(), refreshLeads(), refreshInboxes(), refreshCampaigns()]);
      setLoading(false);
    })();

    const unsubQueue = storage.subscribe(storage.KEYS.queue, refreshQueue);
    const unsubLeads = storage.subscribe(storage.KEYS.leads, refreshLeads);
    const unsubInboxes = storage.subscribe(storage.KEYS.inboxes, refreshInboxes);
    const unsubCampaigns = storage.subscribe(storage.KEYS.campaigns, refreshCampaigns);

    return () => {
      unsubQueue();
      unsubLeads();
      unsubInboxes();
      unsubCampaigns();
    };
  }, [refreshQueue, refreshLeads, refreshInboxes, refreshCampaigns]);

  const leadMap = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const inboxMap = useMemo(() => new Map(inboxes.map((i) => [i.id, i])), [inboxes]);
  const campaignMap = useMemo(() => new Map(campaigns.map((c) => [c.id, c])), [campaigns]);

  const sendItem = async (item: QueueItem) => {
    const inbox = inboxMap.get(item.inboxId);
    if (!inbox?.accessToken || !item.draftId) return;

    setSending(item.id);
    try {
      await sendDraft(inbox.accessToken, item.draftId);

      const updated: QueueItem = {
        ...item,
        status: "sent",
        actualSentAt: new Date().toISOString(),
      };
      await storage.upsert(storage.KEYS.queue, updated);

      const lead = leadMap.get(item.leadId);
      if (lead) await storage.upsert(storage.KEYS.leads, { ...lead, status: "sent" });

      await logAudit("email_sent", undefined, {
        campaignId: item.campaignId,
        leadId: item.leadId,
        inboxId: item.inboxId,
      });
    } catch (err) {
      await storage.upsert(storage.KEYS.queue, { ...item, status: "failed" });
      console.error("Send failed:", err);
    }
    setSending(null);
    await refreshQueue();
  };

  useEffect(() => {
    if (!autoMode) {
      if (schedulerRef.current) clearInterval(schedulerRef.current);
      return;
    }

    const tick = async () => {
      const now = new Date();
      const q = await storage.get<QueueItem>(storage.KEYS.queue);
      const due = q.find(
        (item) =>
          item.status === "drafted" &&
          item.scheduledSendAt &&
          new Date(item.scheduledSendAt) <= now
      );
      if (due) sendItem(due);
    };

    schedulerRef.current = setInterval(tick, 30_000);
    tick();

    return () => {
      if (schedulerRef.current) clearInterval(schedulerRef.current);
    };

  }, [autoMode]);

  const [filterStatus, setFilterStatus] = useState("all");
  const [filterInbox, setFilterInbox] = useState("all");

  const filtered = queue.filter((item) => {
    if (filterStatus !== "all" && item.status !== filterStatus) return false;
    if (filterInbox !== "all" && item.inboxId !== filterInbox) return false;
    return true;
  });

  const counts = queue.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {});

  const nextScheduled = queue
    .filter((i) => i.status === "drafted" && i.scheduledSendAt)
    .sort((a, b) => new Date(a.scheduledSendAt!).getTime() - new Date(b.scheduledSendAt!).getTime())[0];

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1>{tr("queueTitle")}</h1>
          <p>{tr("queueDesc")}</p>
        </div>
        <div className="flex gap-3 items-center">
          <button className="btn btn-ghost btn-sm" onClick={refreshQueue}>
            <RefreshCw size={13} /> {tr("refresh")}
          </button>
          <button
            className={`btn btn-sm ${autoMode ? "btn-danger" : "btn-primary"}`}
            onClick={() => setAutoMode(!autoMode)}
          >
            {autoMode ? <Pause size={13} /> : <Play size={13} />}
            {autoMode ? tr("pauseAutoSend") : tr("enableAutoSend")}
          </button>
        </div>
      </div>

      <div className="stats-row">
        {Object.entries(counts).map(([status, count]) => (
          <div key={status} className="stat-chip">
            <span className="stat-count">{count}</span>
            <span className="stat-label">{status}</span>
          </div>
        ))}
      </div>

      {autoMode && nextScheduled && (
        <div className="info-box mt-4">
          <Clock size={13} />
          <span>
            {tr("autoActive")} <strong>{new Date(nextScheduled.scheduledSendAt!).toLocaleTimeString()}</strong>
          </span>
        </div>
      )}

      <div className="flex gap-3 mt-6" style={{ marginBottom: "var(--sp-4)" }}>
        <select
          className="select"
          style={{ maxWidth: 160 }}
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="all">{tr("allStatuses")}</option>
          <option value="pending">{tr("pending")}</option>
          <option value="drafted">{tr("drafted")}</option>
          <option value="scheduled">{tr("scheduled")}</option>
          <option value="sent">{tr("sent")}</option>
          <option value="failed">{tr("failed")}</option>
        </select>

        <select
          className="select"
          style={{ maxWidth: 200 }}
          value={filterInbox}
          onChange={(e) => setFilterInbox(e.target.value)}
        >
          <option value="all">{tr("allInboxes")}</option>
          {inboxes.map((i) => (
            <option key={i.id} value={i.id}>
              {i.emailAddress}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="empty-state">
          <p className="text-muted">{lang === "fr" ? "Chargement…" : "Loading…"}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("company")}</th>
                  <th>{tr("email")}</th>
                  <th>{tr("inbox")}</th>
                  <th>{tr("campaignCol")}</th>
                  <th>{tr("scheduledCol")}</th>
                  <th>{tr("status")}</th>
                  <th>{tr("action")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const lead = leadMap.get(item.leadId);
                  const inbox = inboxMap.get(item.inboxId);
                  const campaign = campaignMap.get(item.campaignId);

                  return (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 500 }}>{lead?.companyName || "—"}</td>
                      <td className="mono text-sm">{lead?.contactEmail || "—"}</td>
                      <td className="text-sm text-muted">{inbox?.emailAddress || "—"}</td>
                      <td className="text-sm text-muted">{campaign?.name || "—"}</td>
                      <td className="text-sm">
                        {item.scheduledSendAt
                          ? new Date(item.scheduledSendAt).toLocaleString()
                          : item.actualSentAt
                          ? `${tr("sent")} ${new Date(item.actualSentAt).toLocaleTimeString()}`
                          : "—"}
                      </td>
                      <td>
                        <span className={`badge badge-${item.status}`}>{item.status}</span>
                      </td>
                      <td>
                        {item.status === "drafted" && (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => sendItem(item)}
                            disabled={sending === item.id || autoMode}
                          >
                            <Send size={12} />
                            {sending === item.id ? tr("sending") : tr("sendNow")}
                          </button>
                        )}
                        {item.status === "failed" && (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => sendItem(item)}
                            disabled={sending === item.id}
                          >
                            {tr("retry")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <div style={{ fontSize: 40 }}>📭</div>
          <p>{tr("noQueue")}</p>
        </div>
      )}

      <style>{`
        .stats-row { display: flex; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-4); }
        .stat-chip { display: flex; flex-direction: column; align-items: center; padding: var(--sp-3) var(--sp-4); background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: var(--radius); min-width: 80px; }
        .stat-count { font-size: 22px; font-weight: 700; color: var(--text-primary); }
        .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); }
        .info-box { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); background: var(--accent-glow); border-radius: var(--radius); font-size: 13px; color: var(--accent); }
      `}</style>
    </div>
  );
}