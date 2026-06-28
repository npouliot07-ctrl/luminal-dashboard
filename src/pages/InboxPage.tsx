import React, { useState } from "react";
import { Plus, ExternalLink, Pause, Play, Trash2, RefreshCw } from "lucide-react";
import type { Inbox } from "../types";
import { storage } from "../services/storage";
import { signInInbox } from "../services/graphApi";
import { nanoid } from "../utils/nanoid";
import { getAvailableSlots } from "../services/routingEngine";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

export function InboxPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [inboxes, setInboxes] = useState<Inbox[]>(() =>
    storage.get<Inbox>(storage.KEYS.inboxes)
  );
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");

  const save = (updated: Inbox[]) => {
    storage.set(storage.KEYS.inboxes, updated);
    setInboxes(updated);
  };

  const addInbox = () => {
    if (!newEmail.includes("@")) return;
    const inbox: Inbox = {
      id: nanoid(),
      emailAddress: newEmail.trim().toLowerCase(),
      displayName: newName.trim() || newEmail,
      msAccountId: "",
      dailyLimit: 5,
      rampRate: 0.5,
      draftsToday: 0,
      isActive: false,
      addedAt: new Date().toISOString(),
      lastRampedAt: new Date().toISOString(),
    };
    save([...inboxes, inbox]);
    setNewEmail("");
    setNewName("");
    setShowAddForm(false);
  };

  const toggleActive = (id: string) => {
    save(inboxes.map((i) => (i.id === id ? { ...i, isActive: !i.isActive } : i)));
  };

  const updateField = (id: string, field: keyof Inbox, value: number) => {
    save(inboxes.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
  };

  const removeInbox = (id: string) => {
    if (window.confirm(lang === "fr" ? "Supprimer cette boîte ?" : "Remove this inbox?")) {
      save(inboxes.filter((i) => i.id !== id));
    }
  };

  const connectOAuth = async (inbox: Inbox) => {
    try {
      const accessToken = await signInInbox(inbox.emailAddress);
      storage.upsert(storage.KEYS.inboxes, {
        ...inbox,
        accessToken,
        isActive: true,
      });
      save(storage.get<Inbox>(storage.KEYS.inboxes));
      alert(lang === "fr" ? `Connecté !` : `Connected!`);
    } catch (err) {
      console.error("Login failed:", err);
      alert(lang === "fr" ? "Connexion échouée — vérifiez la console." : "Login failed — check the console for details.");
    }
  };

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1>{tr("inboxesTitle")}</h1>
          <p>{lang === "fr" ? `Gérez vos ${inboxes.length} comptes Outlook et leurs limites d'envoi quotidiennes.` : `Manage your ${inboxes.length} Outlook accounts and their daily send limits.`}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
          <Plus size={14} />
          {tr("addInbox")}
        </button>
      </div>

      {showAddForm && (
        <div className="card mt-4" style={{ maxWidth: 480 }}>
          <h2 style={{ marginBottom: "var(--sp-4)" }}>{tr("addNewInbox")}</h2>
          <div className="flex-col gap-4">
            <div className="field">
              <label>{tr("emailAddress")}</label>
              <input
                className="input"
                type="email"
                placeholder="yourname@outlook.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label>{tr("displayName")}</label>
              <input
                className="input"
                placeholder="Inbox 1"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={addInbox} disabled={!newEmail}>
                {tr("addInbox")}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowAddForm(false)}>
                {tr("cancel")}
              </button>
            </div>
          </div>
          <p className="text-muted text-sm mt-4">
            {tr("afterAdding")} <strong>{tr("connect")}</strong> {tr("toAuthenticate")}
          </p>
        </div>
      )}

      {inboxes.length > 0 ? (
        <div className="card mt-6">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("inbox")}</th>
                  <th>{tr("status")}</th>
                  <th>{tr("dailyLimit")}</th>
                  <th>{tr("rampRate")}</th>
                  <th>{tr("draftsToday")}</th>
                  <th>{tr("available")}</th>
                  <th>{tr("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {inboxes.map((inbox) => (
                  <tr key={inbox.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{inbox.displayName}</div>
                      <div className="mono text-muted">{inbox.emailAddress}</div>
                    </td>
                    <td>
                      <span className={`badge ${inbox.isActive ? "badge-active" : "badge-paused"}`}>
                        {inbox.isActive ? tr("active") : tr("inactive")}
                      </span>
                      {!inbox.accessToken && (
                        <span className="badge badge-failed" style={{ marginLeft: 6 }}>
                          {tr("notConnected")}
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={200}
                        step={0.5}
                        value={inbox.dailyLimit}
                        onChange={(e) =>
                          updateField(inbox.id, "dailyLimit", parseFloat(e.target.value))
                        }
                        style={{ width: 70 }}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={5}
                        step={0.5}
                        value={inbox.rampRate}
                        onChange={(e) =>
                          updateField(inbox.id, "rampRate", parseFloat(e.target.value))
                        }
                        style={{ width: 70 }}
                      />
                    </td>
                    <td style={{ fontWeight: 500 }}>{inbox.draftsToday}</td>
                    <td>
                      <span style={{
                        color: getAvailableSlots(inbox) === 0 ? "var(--danger)" : "var(--success)",
                        fontWeight: 600,
                      }}>
                        {getAvailableSlots(inbox)}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => connectOAuth(inbox)}
                        >
                          <ExternalLink size={13} />
                          {tr("connect")}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => toggleActive(inbox.id)}
                        >
                          {inbox.isActive ? <Pause size={13} /> : <Play size={13} />}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeInbox(inbox.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state mt-6">
          <div style={{ fontSize: 40 }}>📬</div>
          <p>{tr("noInboxes")}</p>
          <button className="btn btn-primary" onClick={() => setShowAddForm(true)}>
            <Plus size={14} />
            {tr("addInbox")}
          </button>
        </div>
      )}

      {inboxes.length > 0 && (
        <div className="card mt-4" style={{ background: "var(--accent-glow)", borderColor: "rgba(0,180,216,0.2)" }}>
          <div className="flex gap-3 items-center">
            <RefreshCw size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              {tr("rampInfo")} <strong style={{ color: "var(--text-primary)" }}>{tr("rampRate")}</strong> {tr("rampInfo2")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
