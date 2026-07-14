import React from "react";
import { Outlet, NavLink } from "react-router-dom";
import { Users, Mail, Inbox, ListOrdered, Shield, Zap, BarChart3 } from "lucide-react";
import { useLang } from "../../utils/LangContext";
import { translate } from "../../utils/i18n";
import "./Layout.css";

export function Layout() {
  const { lang, toggleLang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const NAV = [
    { to: "/leads", icon: Users, label: tr("leads") },
    { to: "/campaign", icon: Mail, label: tr("campaign") },
    { to: "/inboxes", icon: Inbox, label: tr("inboxes") },
    { to: "/queue", icon: ListOrdered, label: tr("sendQueue") },
    { to: "/compliance", icon: Shield, label: tr("compliance") },
    { to: "/analytics", icon: BarChart3, label: tr("analytics") },
  ];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Zap size={18} />
          <span>Luminal</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-item ${isActive ? "nav-item--active" : ""}`
              }
            >
              <Icon size={16} />
              {label}
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
    </div>
  );
}