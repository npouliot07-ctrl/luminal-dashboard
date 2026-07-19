import React, { useState, useEffect, useCallback, useMemo } from "react";
import { MailPlus, CheckCheck, User } from "lucide-react";
import type { IncomingMail, Lead, Inbox } from "../types";
import { storage } from "../services/storage";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

export function RepliesPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [mail, setMail] = useState<IncomingMail[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterInbox, setFilterInbox] = useState("all");

  const loadAll = useCallback(async () => {
    const [m, l, i] = await Promise.all([
      storage.get<IncomingMail>(storage.KEYS.incomingMail),
      storage.get<Lead>(storage.KEYS.leads),
      storage.get<Inbox>(storage.KEYS.inboxes),
    ]);
    setMail(m);
    setLeads(l);
    setInboxes(i);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const unsubs = [
      storage.subscribe(storage.KEYS.incomingMail, loadAll),
      storage.subscribe(storage.KEYS.leads, loadAll),
      storage.subscribe(storage.KEYS.inboxes, loadAll),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadAll]);

  const leadMap = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const inboxMap = useMemo(() => new Map(inboxes.map((i) => [i.id, i])), [inboxes]);

  const sorted = useMemo(
    () =>
      mail
        .filter((m) => filterInbox === "all" || m.inboxId === filterInbox)
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()),
    [mail, filterInbox]
  );

  const unreadCount = mail.filter((m) => !m.read).length;

  const markAsRead = async (item: IncomingMail) => {
    if (item.read) return;
    await storage.upsert(storage.KEYS.incomingMail, { ...item, read: true });
  };

  const markAllAsRead = async () => {
    const unread = mail.filter((m) => !m.read);
    await Promise.all(unread.map((m) => storage.upsert(storage.KEYS.incomingMail, { ...m, read: true })));
  };

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1>{tr("replies")}</h1>
          <p>
            {lang === "fr"
              ? "Messages reçus dans vos boîtes connectées — vérifié toutes les 60 secondes pendant que le tableau de bord est ouvert."
              : "Mail received in your connected inboxes — checked every 60 seconds while the dashboard is open."}
          </p>
        </div>
        {unreadCount > 0 && (
          <button className="btn btn-secondary btn-sm" onClick={markAllAsRead}>
            <CheckCheck size={14} /> {lang === "fr" ? "Tout marquer comme lu" : "Mark all read"}
          </button>
        )}
      </div>

      <div className="flex gap-3 mt-4" style={{ marginBottom: "var(--sp-4)" }}>
        <select className="select" style={{ maxWidth: 240 }} value={filterInbox} onChange={(e) => setFilterInbox(e.target.value)}>
          <option value="all">{lang === "fr" ? "Toutes les boîtes" : "All inboxes"}</option>
          {inboxes.map((i) => (
            <option key={i.id} value={i.id}>{i.emailAddress}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-muted">{lang === "fr" ? "Chargement…" : "Loading…"}</p>
      ) : sorted.length > 0 ? (
        <div className="flex-col gap-3">
          {sorted.map((item) => {
            const lead = item.matchedLeadId ? leadMap.get(item.matchedLeadId) : undefined;
            const inbox = inboxMap.get(item.inboxId);
            return (
              <div
                key={item.id}
                className="card"
                style={{
                  cursor: item.read ? "default" : "pointer",
                  borderColor: item.read ? "var(--border-light)" : "rgba(0,180,216,0.35)",
                }}
                onClick={() => markAsRead(item)}
              >
                <div className="flex justify-between items-start">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="flex items-center gap-2">
                      {!item.read && (
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                      )}
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{item.fromName}</span>
                      <span className="text-muted text-sm mono">{item.fromEmail}</span>
                      {lead && (
                        <span className="badge badge-active" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <User size={11} /> {lead.companyName}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 13, color: "var(--text-secondary)" }}>{item.subject}</div>
                    <div className="text-muted text-sm" style={{ marginTop: 4 }}>{item.preview}</div>
                  </div>
                  <div className="text-muted text-sm" style={{ whiteSpace: "nowrap", marginLeft: "var(--sp-3)" }}>
                    {new Date(item.receivedAt).toLocaleString()}
                    <div style={{ marginTop: 2 }}>{inbox?.emailAddress}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <MailPlus size={32} />
          <p>{lang === "fr" ? "Aucun message reçu pour l'instant." : "No mail received yet."}</p>
        </div>
      )}
    </div>
  );
}