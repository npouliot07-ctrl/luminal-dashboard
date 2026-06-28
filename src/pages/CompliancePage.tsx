import React, { useState } from "react";
import { Plus, Trash2, Shield } from "lucide-react";
import type { SuppressionEntry, AuditEntry } from "../types";
import { storage } from "../services/storage";
import { addToSuppressionList } from "../services/compliance";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

export function CompliancePage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [suppression, setSuppression] = useState<SuppressionEntry[]>(() =>
    storage.get<SuppressionEntry>(storage.KEYS.suppression)
  );
  const [audit] = useState<AuditEntry[]>(() =>
    storage.get<AuditEntry>(storage.KEYS.audit).slice(0, 100)
  );

  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState<SuppressionEntry["reason"]>("manual");

  const addEntry = () => {
    if (!newEmail.includes("@")) return;
    addToSuppressionList(newEmail.trim(), newReason);
    setSuppression(storage.get<SuppressionEntry>(storage.KEYS.suppression));
    setNewEmail("");
  };

  const removeEntry = (id: string) => {
    storage.remove<SuppressionEntry>(storage.KEYS.suppression, id);
    setSuppression(storage.get<SuppressionEntry>(storage.KEYS.suppression));
  };

  return (
    <div>
      <div className="page-header">
        <h1>{tr("complianceTitle")}</h1>
        <p>{tr("complianceDesc")}</p>
      </div>

      <div className="card" style={{ maxWidth: 520 }}>
        <h2 style={{ marginBottom: "var(--sp-4)" }}>{tr("addToSuppression")}</h2>
        <div className="flex gap-3">
          <input
            className="input"
            type="email"
            placeholder="email@domain.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addEntry()}
          />
          <select
            className="select"
            style={{ maxWidth: 160 }}
            value={newReason}
            onChange={(e) => setNewReason(e.target.value as SuppressionEntry["reason"])}
          >
            <option value="manual">{tr("manual")}</option>
            <option value="unsubscribed">{tr("unsubscribed")}</option>
            <option value="bounced">{tr("bounced")}</option>
          </select>
          <button className="btn btn-primary" onClick={addEntry} disabled={!newEmail}>
            <Plus size={14} /> {tr("add")}
          </button>
        </div>
      </div>

      <div className="card mt-6">
        <div className="card-header">
          <h2>{tr("suppressionList")} ({suppression.length})</h2>
          <div className="flex items-center gap-2" style={{ color: "var(--success)", fontSize: 13 }}>
            <Shield size={14} />
            <span>{tr("checkedOnImport")}</span>
          </div>
        </div>

        {suppression.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("email")}</th>
                  <th>{tr("reason")}</th>
                  <th>{tr("addedDate")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {suppression.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.emailAddress}</td>
                    <td>
                      <span
                        className={`badge ${
                          entry.reason === "unsubscribed"
                            ? "badge-paused"
                            : entry.reason === "bounced"
                            ? "badge-failed"
                            : "badge-suppressed"
                        }`}
                      >
                        {tr(entry.reason)}
                      </span>
                    </td>
                    <td className="text-muted text-sm">
                      {new Date(entry.addedAt).toLocaleDateString()}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeEntry(entry.id)}
                        title={tr("remove")}
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
            <Shield size={32} />
            <p>{tr("noSuppressed")}</p>
          </div>
        )}
      </div>

      {audit.length > 0 && (
        <div className="card mt-6">
          <h2 style={{ marginBottom: "var(--sp-4)" }}>{tr("auditLog")}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("time")}</th>
                  <th>{tr("event")}</th>
                  <th>{tr("detail")}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono text-sm text-muted">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td style={{ fontWeight: 500 }}>{entry.event}</td>
                    <td className="text-muted text-sm">{entry.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
