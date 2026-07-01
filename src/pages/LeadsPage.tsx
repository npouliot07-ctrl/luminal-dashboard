import React, { useState, useCallback, useEffect } from "react";
import { Upload, AlertTriangle, CheckCircle, Trash2, Users } from "lucide-react";
import type { Lead } from "../types";
import { storage } from "../services/storage";
import { parseCsvToLeads, deduplicateLeads } from "../utils/csvParser";
import { filterSuppressedLeads } from "../services/compliance";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

// Database write-order (updated_at) doesn't match CSV row order once you're
// bulk-importing — sort by each lead's own createdAt instead, which is
// assigned sequentially as csvParser walks the file top to bottom.
function sortByCreatedAt(leads: Lead[]): Lead[] {
  return [...leads].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export function LeadsPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    added: number;
    duplicates: number;
    suppressed: number;
    errors: string[];
  } | null>(null);

  const loadLeads = useCallback(async () => {
    const data = await storage.get<Lead>(storage.KEYS.leads);
    setLeads(sortByCreatedAt(data));
    setLoading(false);
  }, []);

  // Initial load + live sync when your partner adds/edits leads
  useEffect(() => {
    loadLeads();
    const unsubscribe = storage.subscribe(storage.KEYS.leads, loadLeads);
    return unsubscribe;
  }, [loadLeads]);

  const handleFile = useCallback(async (file: File) => {
    setImporting(true);
    setImportResult(null);
    const { leads: parsed, errors } = await parseCsvToLeads(file);
    const existing = await storage.get<Lead>(storage.KEYS.leads);
    const { unique, duplicates } = deduplicateLeads(parsed, existing);
    const { clean, suppressed } = await filterSuppressedLeads(unique);
    const allLeads = [...existing, ...clean, ...suppressed];
    await storage.set(storage.KEYS.leads, allLeads);
    setLeads(sortByCreatedAt(allLeads));
    setImportResult({ added: clean.length, duplicates, suppressed: suppressed.length, errors });
    setImporting(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith(".csv")) handleFile(file);
  }, [handleFile]);

  const handleClearAll = async () => {
    if (window.confirm(lang === "fr" ? "Supprimer tous les prospects ?" : "Remove all leads?")) {
      await storage.set(storage.KEYS.leads, []);
      setLeads([]);
      setImportResult(null);
    }
  };

  const statusCounts = leads.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="page-header">
        <h1>{tr("leadsTitle")}</h1>
        <p>{tr("leadsDesc")}</p>
      </div>

      {leads.length > 0 && (
        <div className="stats-row">
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} className="stat-chip">
              <span className="stat-count">{count}</span>
              <span className="stat-label">{status}</span>
            </div>
          ))}
        </div>
      )}

      <div
        className="drop-zone card"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <input
          type="file"
          accept=".csv"
          id="csv-upload"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
        <Upload size={28} className="text-muted" />
        <p>{tr("dropCsv")}</p>
        <label htmlFor="csv-upload" className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {importing ? tr("importing") : tr("chooseFile")}
        </label>
        <p className="text-sm text-muted">
          {tr("requiredColumns")} <span className="mono">email, name, company, website</span>
        </p>
      </div>

      {importResult && (
        <div className="import-result card mt-4">
          <div className="flex gap-4">
            <div className="result-item result-success">
              <CheckCircle size={14} />
              {importResult.added} {tr("added")}
            </div>
            {importResult.duplicates > 0 && (
              <div className="result-item result-warn">
                {importResult.duplicates} {tr("duplicatesSkipped")}
              </div>
            )}
            {importResult.suppressed > 0 && (
              <div className="result-item result-warn">
                {importResult.suppressed} {tr("suppressed")}
              </div>
            )}
            {importResult.errors.length > 0 && (
              <div className="result-item result-error">
                <AlertTriangle size={14} />
                {importResult.errors.length} {tr("rowErrors")}
              </div>
            )}
          </div>
          {importResult.errors.length > 0 && (
            <ul className="error-list text-sm">
              {importResult.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {importResult.errors.length > 5 && (
                <li>…and {importResult.errors.length - 5} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="empty-state mt-6">
          <p className="text-muted">{lang === "fr" ? "Chargement…" : "Loading…"}</p>
        </div>
      ) : (
        <>
          {leads.length > 0 && (
            <div className="card mt-6">
              <div className="card-header">
                <h2>{leads.length} {tr("leadsTitle").toLowerCase()}</h2>
                <button className="btn btn-danger btn-sm" onClick={handleClearAll}>
                  <Trash2 size={13} />
                  {tr("clearAll")}
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("company")}</th>
                      <th>{tr("email")}</th>
                      <th>Website</th>
                      <th>Source</th>
                      <th>{tr("status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.slice(0, 200).map((lead) => (
                      <tr key={lead.id}>
                        <td style={{ fontWeight: 500 }}>{lead.companyName}</td>
                        <td className="mono">{lead.contactEmail}</td>
                        <td className="text-muted text-sm">{lead.websiteUrl || "—"}</td>
                        <td className="text-muted text-sm">{lead.sourceFile}</td>
                        <td>
                          <span className={`badge badge-${lead.status}`}>
                            {lead.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {leads.length > 200 && (
                  <p className="text-muted text-sm" style={{ padding: "var(--sp-3)", textAlign: "center" }}>
                    {lang === "fr" ? `Affichage de 200 sur ${leads.length} prospects` : `Showing 200 of ${leads.length} leads`}
                  </p>
                )}
              </div>
            </div>
          )}

          {leads.length === 0 && !importResult && (
            <div className="empty-state mt-6">
              <Users size={40} />
              <p>{tr("noLeads")}</p>
            </div>
          )}
        </>
      )}

      <style>{`
        .stats-row { display: flex; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-4); }
        .stat-chip { display: flex; flex-direction: column; align-items: center; padding: var(--sp-3) var(--sp-4); background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: var(--radius); min-width: 80px; }
        .stat-count { font-size: 22px; font-weight: 700; color: var(--text-primary); }
        .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); }
        .drop-zone { display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); padding: var(--sp-8) var(--sp-4); border: 2px dashed var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); text-align: center; transition: border-color 0.15s; cursor: default; }
        .drop-zone:hover { border-color: var(--accent); }
        .import-result { padding: var(--sp-4); }
        .result-item { display: flex; align-items: center; gap: var(--sp-1); font-size: 13px; font-weight: 500; }
        .result-success { color: var(--success); }
        .result-warn { color: var(--warning); }
        .result-error { color: var(--danger); }
        .error-list { margin-top: var(--sp-3); padding-left: var(--sp-4); color: var(--danger); }
        .error-list li { margin-bottom: var(--sp-1); }
      `}</style>
    </div>
  );
}
