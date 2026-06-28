import React, { useState, useCallback } from "react";
import {
  Settings, Zap, Send, ChevronDown, ChevronUp, Edit2, Check, X, Clock
} from "lucide-react";
import type { Lead, Campaign, GeneratedEmail, QueueItem, Inbox } from "../types";
import { storage } from "../services/storage";
import { generateEmailBatch } from "../services/emailGenerator";
import { distributeLeads, buildQueueItems } from "../services/routingEngine";
import { filterSuppressedLeads, logAudit } from "../services/compliance";
import { createOutlookDraft } from "../services/graphApi";
import { nanoid } from "../utils/nanoid";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

type Step = "configure" | "preview" | "drafting" | "done";

export function CampaignPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);
  const [name, setName] = useState("");
  const [startRow, setStartRow] = useState(1);
  const [endRow, setEndRow] = useState(50);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [gapMinutes, setGapMinutes] = useState(4);
  const [generator, setGenerator] = useState("Nathaniel Pouliot");

  const [step, setStep] = useState<Step>("configure");
  const [campaign, setCampaign] = useState<Campaign | null>(null);

  const [generatedEmails, setGeneratedEmails] = useState<GeneratedEmail[]>([]);
  const [genProgress, setGenProgress] = useState({ done: 0, total: 0 });
  const [generating, setGenerating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [draftProgress, setDraftProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [drafting, setDrafting] = useState(false);

  const readyLeads = storage
    .get<Lead>(storage.KEYS.leads)
    .filter((l) => l.status === "new");

  const activeInboxes = storage
    .get<Inbox>(storage.KEYS.inboxes)
    .filter((i) => i.isActive && i.accessToken);

  const selectedCount = Math.min(endRow, readyLeads.length) - Math.max(startRow - 1, 0);

  const handleGenerate = async () => {
    const selected = readyLeads.slice(startRow - 1, endRow);
    const { clean } = filterSuppressedLeads(selected);
    if (clean.length === 0) return;

    const newCampaign: Campaign = {
      id: nanoid(),
      name: name || `Campaign ${new Date().toLocaleDateString()}`,
      totalLeads: clean.length,
      status: "draft",
      schedulingMode: mode,
      gapMinutes,
      createdAt: new Date().toISOString(),
    };

    storage.upsert(storage.KEYS.campaigns, newCampaign);
    setCampaign(newCampaign);
    setGenerating(true);
    setGenProgress({ done: 0, total: clean.length });

    for (const lead of clean) {
      storage.upsert(storage.KEYS.leads, { ...lead, status: "generating" });
    }

    const emails = await generateEmailBatch(
      clean,
      (done, total) => setGenProgress({ done, total }),
      generator
    );

    for (const email of emails) {
      storage.upsert(storage.KEYS.emails, email);
    }

    setGeneratedEmails(emails);
    setGenerating(false);
    setStep("preview");
    logAudit("emails_generated", `${emails.length} emails generated`, {
      campaignId: newCampaign.id,
    });
  };


  const startEdit = (email: GeneratedEmail) => {
    setEditingId(email.id);
    setEditSubject(email.subjectLine);
    setEditBody(email.body.replace(/<p>/g, "").replace(/<\/p>/g, "\n\n").replace(/<br\/>/g, "\n").trim());
  };

  const saveEdit = (emailId: string) => {
    const updated = generatedEmails.map((e) => {
      if (e.id !== emailId) return e;
      const newEmail = {
        ...e,
        subjectLine: editSubject,
        body: editBody
          .split(/\n\n+/)
          .map((p) => `<p>${p.replace(/\n/g, "<br/>").trim()}</p>`)
          .join("\n"),
        editedAt: new Date().toISOString(),
        approved: true,
      };
      storage.upsert(storage.KEYS.emails, newEmail);
      return newEmail;
    });
    setGeneratedEmails(updated);
    setEditingId(null);
  };

  const toggleApprove = (emailId: string) => {
    const updated = generatedEmails.map((e) => {
      if (e.id !== emailId) return e;
      const toggled = { ...e, approved: !e.approved };
      storage.upsert(storage.KEYS.emails, toggled);
      return toggled;
    });
    setGeneratedEmails(updated);
  };

  const approveAll = () => {
    const updated = generatedEmails.map((e) => {
      const approved = { ...e, approved: true };
      storage.upsert(storage.KEYS.emails, approved);
      return approved;
    });
    setGeneratedEmails(updated);
  };

  // ── Step 2: Create drafts ──────────────────────────────────────────────────

  const handleCreateDrafts = async () => {
    if (!campaign) return;
    const approved = generatedEmails.filter((e) => e.approved);
    if (approved.length === 0) return;

    setDrafting(true);
    setStep("drafting");

    const leads = storage.get<Lead>(storage.KEYS.leads);
    const inboxes = storage.get<Inbox>(storage.KEYS.inboxes);

    const leadMap = new Map(leads.map((l) => [l.id, l]));
    const approvedLeads = approved
      .map((e) => leadMap.get(e.leadId))
      .filter(Boolean) as Lead[];

    const distribution = distributeLeads(approvedLeads, inboxes);
    const emailIdMap = new Map<string, string>(approved.map((e) => [e.leadId, e.id]));
    const queueItems = buildQueueItems(campaign, emailIdMap, distribution);

    for (const item of queueItems) {
      storage.upsert(storage.KEYS.queue, item);
    }

    setDraftProgress({ done: 0, total: queueItems.length, failed: 0 });

    let done = 0;
    let failed = 0;

    for (const item of queueItems) {
      const inbox = inboxes.find((i) => i.id === item.inboxId);
      const email = approved.find((e) => e.id === item.emailId);
      const lead = leadMap.get(item.leadId);

      if (!inbox?.accessToken || !email || !lead) {
        failed++;
        storage.upsert(storage.KEYS.queue, { ...item, status: "failed" });
        setDraftProgress((p) => ({ ...p, done: ++done, failed }));
        continue;
      }

      try {
        const draftId = await createOutlookDraft(
          inbox.accessToken,
          {
            toEmail: lead.contactEmail,
            toName: lead.contactName,
            subject: email.subjectLine,
            bodyHtml: email.body,
          }
        );

        storage.upsert(storage.KEYS.queue, { ...item, draftId, status: "drafted" });
        storage.upsert(storage.KEYS.leads, { ...lead, status: "drafted" });
        storage.upsert(storage.KEYS.inboxes, {
          ...inbox,
          draftsToday: inbox.draftsToday + 1,
        });

        logAudit("draft_created", `Draft created in ${inbox.emailAddress}`, {
          campaignId: campaign.id,
          leadId: lead.id,
          inboxId: inbox.id,
        });
      } catch (err) {
        failed++;
        storage.upsert(storage.KEYS.queue, { ...item, status: "failed" });
        console.error("Draft creation failed:", err);
      }

      setDraftProgress((p) => ({ ...p, done: ++done, failed }));
    }

    storage.upsert(storage.KEYS.campaigns, { ...campaign, status: "active", launchedAt: new Date().toISOString() });
    setDrafting(false);
    setStep("done");
  };

  const approvedCount = generatedEmails.filter((e) => e.approved).length;

  return (
    <div>
      <div className="page-header">
        <h1>Campaign</h1>
        <p>Configure, generate, preview, and push email drafts to Outlook.</p>
      </div>

      {/* Step indicator */}
      <div className="step-bar">
        {(["configure", "preview", "drafting", "done"] as Step[]).map((s, i) => (
          <div key={s} className={`step ${step === s ? "step--active" : step > s ? "step--done" : ""}`}>
            <div className="step-dot">{i + 1}</div>
            <span>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
          </div>
        ))}
      </div>

      {step === "configure" && (
        <div className="card mt-6" style={{ maxWidth: 560 }}>
          <h2 style={{ marginBottom: "var(--sp-5)" }}>{tr("campaignSettings")}</h2>

          <div className="flex-col gap-4">
            <div className="field">
              <label>{tr("campaignName")}</label>
              <input
                className="input"
                placeholder={tr("campaignPlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="field">
              <label>{tr("rowRange")}</label>
              <div className="flex gap-2 items-center">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={readyLeads.length}
                  value={startRow}
                  onChange={(e) => setStartRow(parseInt(e.target.value) || 1)}
                  style={{ maxWidth: 100 }}
                />
                <span style={{ color: "var(--text-muted)" }}>{tr("to")}</span>
                <input
                  className="input"
                  type="number"
                  min={startRow}
                  max={readyLeads.length}
                  value={endRow}
                  onChange={(e) => setEndRow(parseInt(e.target.value) || 50)}
                  style={{ maxWidth: 100 }}
                />
              </div>
              <span className="text-muted text-sm">
                {readyLeads.length} leads available · processing {Math.max(0, selectedCount)} leads
              </span>
            </div>

            <div className="field">
              <label>{tr("signature")}</label>
              <select
                className="select"
                value={generator}
                onChange={(e) => setGenerator(e.target.value)}
              >
                <option value="Nathaniel Pouliot">Nathaniel Pouliot</option>
                <option value="Mathys Gagnon">Mathys Gagnon</option>
              </select>
            </div>

            <div className="field">
              <label>{tr("schedulingMode")}</label>
              <select
                className="select"
                value={mode}
                onChange={(e) => setMode(e.target.value as "auto" | "manual")}
              >
                <option value="auto">Auto — schedule sends with time gaps</option>
                <option value="manual">Manual — I'll trigger sends myself</option>
              </select>
            </div>

            {mode === "auto" && (
              <div className="field">
                <label>{tr("gapMinutes")}</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={60}
                  value={gapMinutes}
                  onChange={(e) => setGapMinutes(parseInt(e.target.value))}
                  style={{ maxWidth: 120 }}
                />
              </div>
            )}

            <div className="info-box">
              <Settings size={13} />
              <span>{activeInboxes.length} active inbox{activeInboxes.length !== 1 ? "es" : ""} ready to receive drafts</span>
            </div>

            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={generating || readyLeads.length === 0 || activeInboxes.length === 0 || selectedCount <= 0}
            >
              <Zap size={14} />
              {generating
                ? `${tr("generating")} ${genProgress.done}/${genProgress.total}`
                : tr("generateEmails")}
            </button>

            {generating && (
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(genProgress.done / genProgress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="mt-6">
          <div className="flex justify-between items-center" style={{ marginBottom: "var(--sp-4)" }}>
            <h2>{generatedEmails.length} emails generated — review before pushing to Outlook</h2>
            <div className="flex gap-2">
              <button className="btn btn-secondary btn-sm" onClick={approveAll}>
                <Check size={13} /> {tr("approveAll")}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateDrafts}
                disabled={approvedCount === 0}
              >
                <Send size={14} />
                Create {approvedCount} draft{approvedCount !== 1 ? "s" : ""} in Outlook
              </button>
            </div>
          </div>

          <div className="flex-col gap-3">
            {generatedEmails.map((email) => {
              const lead = storage
                .get<Lead>(storage.KEYS.leads)
                .find((l) => l.id === email.leadId);
              const isExpanded = expandedId === email.id;
              const isEditing = editingId === email.id;

              return (
                <div key={email.id} className={`email-card card ${email.approved ? "email-card--approved" : ""}`}>
                  <div className="flex justify-between items-center">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {lead?.companyName || "Unknown"}
                        {lead && (
                          <span className="text-muted" style={{ fontWeight: 400 }}>
                            {" "}· {lead.contactEmail}
                          </span>
                        )}
                      </div>
                      {!isEditing && (
                        <div className="text-sm" style={{ color: "var(--text-secondary)", marginTop: 2 }}>
                          {email.subjectLine}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        className={`btn btn-sm ${email.approved ? "btn-secondary" : "btn-primary"}`}
                        onClick={() => toggleApprove(email.id)}
                      >
                        {email.approved ? <X size={12} /> : <Check size={12} />}
                        {email.approved ? "Unapprove" : "Approve"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => startEdit(email)}
                        disabled={isEditing}
                      >
                        <Edit2 size={12} /> {tr("edit")}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setExpandedId(isExpanded ? null : email.id)}
                      >
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="flex-col gap-3" style={{ marginTop: "var(--sp-4)" }}>
                      <div className="field">
                        <label>Subject line</label>
                        <input
                          className="input"
                          value={editSubject}
                          onChange={(e) => setEditSubject(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label>Body (use blank lines between paragraphs)</label>
                        <textarea
                          className="textarea"
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={10}
                        />
                      </div>
                      <div className="flex gap-2">
                        <button className="btn btn-primary btn-sm" onClick={() => saveEdit(email.id)}>
                          <Check size={13} /> {tr("save")}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                          {tr("cancel")}
                        </button>
                      </div>
                    </div>
                  )}

                  {isExpanded && !isEditing && (
                    <div
                      className="email-body-preview"
                      dangerouslySetInnerHTML={{ __html: email.body }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {step === "drafting" && (
        <div className="card mt-6" style={{ maxWidth: 480, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: "var(--sp-4)" }}>📤</div>
          <h2>{tr("creatingDrafts")}</h2>
          <p className="mt-4">
            {draftProgress.done} of {draftProgress.total} drafts created
            {draftProgress.failed > 0 && ` · ${draftProgress.failed} failed`}
          </p>
          <div className="progress-bar mt-4">
            <div
              className="progress-fill"
              style={{
                width: `${(draftProgress.done / Math.max(draftProgress.total, 1)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="card mt-6" style={{ maxWidth: 480, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: "var(--sp-4)" }}>✅</div>
          <h2>{tr("draftsCreated")}</h2>
          <p className="mt-4">
            {draftProgress.done - draftProgress.failed} drafts pushed to Outlook.
            {draftProgress.failed > 0 && ` ${draftProgress.failed} failed — check the queue.`}
          </p>
          <div className="flex gap-3 mt-4" style={{ justifyContent: "center" }}>
            <a href="/queue" className="btn btn-primary">
              <Clock size={14} /> {tr("viewQueue")}
            </a>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setStep("configure");
                setGeneratedEmails([]);
                setCampaign(null);
                setName("");
              }}
            >
              {tr("newCampaign")}
            </button>
          </div>
        </div>
      )}

      <style>{`
        .step-bar { display: flex; gap: 0; margin: var(--sp-6) 0 0; }
        .step { display: flex; align-items: center; gap: var(--sp-2); font-size: 13px; color: var(--text-muted); padding-right: var(--sp-6); position: relative; }
        .step:not(:last-child)::after { content: "→"; margin-left: var(--sp-2); color: var(--border); }
        .step--active { color: var(--accent); }
        .step--done { color: var(--success); }
        .step-dot { width: 20px; height: 20px; border-radius: 50%; background: var(--bg-elevated); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
        .step--active .step-dot { background: var(--accent); color: #000; border-color: var(--accent); }
        .step--done .step-dot { background: var(--success); color: #000; border-color: var(--success); }
        .info-box { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); background: var(--accent-glow); border-radius: var(--radius); font-size: 13px; color: var(--accent); }
        .email-card { transition: border-color 0.15s; }
        .email-card--approved { border-color: rgba(63,185,80,0.35); }
        .email-body-preview { margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--border-light); font-size: 13px; line-height: 1.7; color: var(--text-secondary); }
        .email-body-preview p { margin-bottom: var(--sp-3); }
      `}</style>
    </div>
  );
}
