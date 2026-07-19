import React, { useEffect, useState, useCallback, useRef } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { Users, Mail, Inbox, ListOrdered, Shield, Zap, BarChart3, MailPlus, X } from "lucide-react";
import { useLang } from "../../utils/LangContext";
import { translate } from "../../utils/i18n";
import { storage } from "../../services/storage";
import { checkAllInboxesForMail } from "../../services/mailChecker";
import type { Lead, Inbox as InboxType, IncomingMail } from "../../types";
import "./Layout.css";

export function Layout() {
  const { lang, toggleLang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [unreadCount, setUnreadCount] = useState(0);
  const [toasts, setToasts] = useState<IncomingMail[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshUnreadCount = useCallback(async () => {
    const mail = await storage.get<IncomingMail>(storage.KEYS.incomingMail);
    setUnreadCount(mail.filter((m) => !m.read).length);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const runMailCheck = useCallback(async () => {
    try {
      const [leads, inboxes] = await Promise.all([
        storage.get<Lead>(storage.KEYS.leads),
        storage.get<InboxType>(storage.KEYS.inboxes),
      ]);
      const newMail = await checkAllInboxesForMail(inboxes, leads);
      if (newMail.length > 0) {
        setToasts((prev) => [...newMail, ...prev].slice(0, 5));
        newMail.forEach((m) => {
          setTimeout(() => dismissToast(m.id), 8000);
        });
      }
      await refreshUnreadCount();
    } catch (err) {
      console.error("Mail check failed:", err);
    }
  }, [refreshUnreadCount]);

  useEffect(() => {
    // Immediate check on load — this is what catches mail that arrived
    // while the tab/browser was closed, not just what arrives from now on.
    runMailCheck();
    refreshUnreadCount();

    pollRef.current = setInterval(runMailCheck, 55_000 + Math.random() * 10_000);
    const unsub = storage.subscribe(storage.KEYS.incomingMail, refreshUnreadCount);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      unsub();
    };
  }, [runMailCheck, refreshUnreadCount]);

  const NAV = [
    { to: "/leads", icon: Users, label: tr("leads") },
    { to: "/campaign", icon: Mail, label: tr("campaign") },
    { to: "/inboxes", icon: Inbox, label: tr("inboxes") },
    { to: "/queue", icon: ListOrdered, label: tr("sendQueue") },
    { to: "/compliance", icon: Shield, label: tr("compliance") },
    { to: "/analytics", icon: BarChart3, label: tr("analytics") },
    { to: "/replies", icon: MailPlus, label: tr("replies"), badge: unreadCount },
  ];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Zap size={18} />
          <span>Luminal</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(({ to, icon: Icon, label, badge }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-item ${isActive ? "nav-item--active" : ""}`
              }
              style={{ position: "relative" }}
            >
              <Icon size={16} />
              {label}
              {!!badge && (
                <span
                  style={{
                    marginLeft: "auto",
                    background: "var(--accent)",
                    color: "#000",
                    fontSize: 11,
                    fontWeight: 700,
                    borderRadius: 999,
                    minWidth: 18,
                    height: 18,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 5px",
                  }}
                >
                  {badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: "auto", paddingTop: "var(--sp-4)" }}>
          <button
            className="btn btn-ghost"
            onClick={toggleLang}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {lang === "en" ? "🇫🇷 Français" : "🇬🇧 English"}
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>

      {/* New-mail toast notifications */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "var(--sp-4)",
            right: "var(--sp-4)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-2)",
            zIndex: 1000,
            width: 320,
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className="card"
              style={{
                padding: "var(--sp-3)",
                display: "flex",
                gap: "var(--sp-2)",
                alignItems: "flex-start",
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              }}
            >
              <MailPlus size={16} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {lang === "fr" ? "Nouveau message" : "New reply"} — {t.fromName}
                </div>
                <div className="text-muted text-sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.subject}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => dismissToast(t.id)}
                style={{ padding: 4, flexShrink: 0 }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}