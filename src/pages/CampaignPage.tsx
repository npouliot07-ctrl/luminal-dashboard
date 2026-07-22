import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Settings, Zap, Send, ChevronDown, ChevronUp, Edit2, Check, X, Clock
} from "lucide-react";
import type { Lead, Campaign, GeneratedEmail, QueueItem, Inbox } from "../types";
import { storage } from "../services/storage";
import { generateEmailBatch } from "../services/emailGenerator";
import { distributeLeads, buildQueueItems } from "../services/routingEngine";
import { filterSuppressedLeads, logAudit } from "../services/compliance";
import { createOutlookDraft, getValidAccessToken } from "../services/graphApi";
import { nanoid } from "../utils/nanoid";
import { useLang } from "../utils/LangContext";
import { translate } from "../utils/i18n";

type Step = "configure" | "preview" | "drafting" | "done";

// Database write-order doesn't match CSV row order once you're bulk-importing —
// sort by each lead's own createdAt instead (assigned sequentially as
// csvParser walks the file), same as LeadsPage, so "row 1 to 3" here means
// the same thing as "row 1 to 3" on the Leads page.
function sortByCreatedAt(leads: Lead[]): Lead[] {
  return [...leads].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export function CampaignPage() {
  const { lang } = useLang();
  const tr = (key: string) => translate(key, lang);
  const [name, setName] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("new");
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

  // ── Live data: leads + inboxes + campaigns ────────────────────────────────
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const loadLeads = useCallback(async () => {
    setLeads(sortByCreatedAt(await storage.get<Lead>(storage.KEYS.leads)));
  }, []);
  const loadInboxes = useCallback(async () => {
    setInboxes(await storage.get<Inbox>(storage.KEYS.inboxes));
  }, []);
  const loadCampaignsList = useCallback(async () => {
    setCampaignsList(await storage.get<Campaign>(storage.KEYS.campaigns));
  }, []);

  // Initial load + live sync (e.g. your partner imports leads or connects an inbox mid-session)
  useEffect(() => {
    (async () => {
      await Promise.all([loadLeads(), loadInboxes(), loadCampaignsList()]);
      setDataLoading(false);
    })();

    const unsubLeads = storage.subscribe(storage.KEYS.leads, loadLeads);
    const unsubInboxes = storage.subscribe(storage.KEYS.inboxes, loadInboxes);
    const unsubCampaigns = storage.subscribe(storage.KEYS.campaigns, loadCampaignsList);

    return () => {
      unsubLeads();
      unsubInboxes();
      unsubCampaigns();
    };
  }, [loadLeads, loadInboxes, loadCampaignsList]);

  const readyLeads = useMemo(() => leads.filter((l) => l.status === "new"), [leads]);
  // "Active" here means eligible for planning purposes — connection status
  // is checked separately at actual draft-creation time, not here. This
  // lets you plan/generate a campaign across inboxes you haven't connected
  // yet and connect them incrementally afterward.
  const activeInboxes = useMemo(() => inboxes.filter((i) => i.isActive), [inboxes]);
  const connectedInboxCount = useMemo(() => inboxes.filter((i) => i.isActive && i.refreshToken).length, [inboxes]);
  const leadMap = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);

  const selectedCount = Math.min(endRow, readyLeads.length) - Math.max(startRow - 1, 0);

  const handleGenerate = async () => {
    // Fresh, correctly-ordered snapshot right before generating — avoids
    // acting on stale state if your partner just generated on overlapping
    // rows a moment ago.
    const freshLeads = sortByCreatedAt(await storage.get<Lead>(storage.KEYS.leads));
    const freshReady = freshLeads.filter((l) => l.status === "new");
    const selected = freshReady.slice(startRow - 1, endRow);

    if (selected.length === 0) {
      alert(lang === "fr" ? "Aucun prospect dans cette plage." : "No leads in that row range.");
      return;
    }

    // Duplicate-generation check: a "new"-status lead should never already
    // have a generated email, but this catches races — e.g. you and your
    // partner both hitting Generate on overlapping rows within moments of
    // each other — before it wastes an AI call and creates a duplicate draft.
    const existingEmails = await storage.get<GeneratedEmail>(storage.KEYS.emails);
    const alreadyGeneratedIds = new Set(existingEmails.map((e) => e.leadId));
    const duplicates = selected.filter((l) => alreadyGeneratedIds.has(l.id));

    let toGenerate = selected;
    if (duplicates.length > 0) {
      const names = duplicates.slice(0, 10).map((l) => l.companyName || l.contactEmail).join(", ");
      const more = duplicates.length > 10 ? ` (+${duplicates.length - 10} more)` : "";
      const proceed = window.confirm(
        lang === "fr"
          ? `${duplicates.length} prospect(s) sélectionné(s) ont déjà un email généré : ${names}${more}. Les ignorer et continuer avec les autres ?`
          : `${duplicates.length} selected lead(s) already have a generated email on file: ${names}${more}. Skip them and continue with the rest?`
      );
      if (!proceed) return;
      toGenerate = selected.filter((l) => !alreadyGeneratedIds.has(l.id));
    }

    if (toGenerate.length === 0) return;

    const { clean } = await filterSuppressedLeads(toGenerate);
    if (clean.length === 0) return;

    let activeCampaign: Campaign;
    if (selectedCampaignId === "new") {
      activeCampaign = {
        id: nanoid(),
        name: name || `Campaign ${new Date().toLocaleDateString()}`,
        totalLeads: clean.length,
        status: "draft",
        schedulingMode: mode,
        gapMinutes,
        createdAt: new Date().toISOString(),
      };
      await storage.upsert(storage.KEYS.campaigns, activeCampaign);
      await logAudit("campaign_created", activeCampaign.name, { campaignId: activeCampaign.id });
    } else {
      // Adding this batch to an existing campaign instead of spawning a new
      // one — bumps its contact count rather than overwriting it.
      const existing = campaignsList.find((c) => c.id === selectedCampaignId);
      if (!existing) {
        alert(lang === "fr" ? "Campagne introuvable — actualisez la page." : "Selected campaign not found — refresh the page.");
        return;
      }
      activeCampaign = {
        ...existing,
        totalLeads: existing.totalLeads + clean.length,
        // Whatever's currently selected in the form should always apply to
        // this batch — previously this silently kept the campaign's
        // original scheduling mode/gap from whenever it was first created,
        // ignoring the dropdowns on screen.
        schedulingMode: mode,
        gapMinutes,
      };
      await storage.upsert(storage.KEYS.campaigns, activeCampaign);
    }

    setCampaign(activeCampaign);
    setGenerating(true);
    setGenProgress({ done: 0, total: clean.length });

    await Promise.all(
      clean.map((lead) => storage.upsert(storage.KEYS.leads, { ...lead, status: "generating" }))
    );

    const emails = await generateEmailBatch(
      clean,
      (done, total) => setGenProgress({ done, total }),
      generator
    );

    await Promise.all(emails.map((email) => storage.upsert(storage.KEYS.emails, email)));

    setGeneratedEmails(emails);
    setGenerating(false);
    setStep("preview");
    await logAudit("emails_generated", `${emails.length} emails generated`, {
      campaignId: activeCampaign.id,
    });

    // Refresh local lead state so leadMap/readyLeads reflect the new "generating" status
    await loadLeads();
  };


  const startEdit = (email: GeneratedEmail) => {
    setEditingId(email.id);
    setEditSubject(email.subjectLine);
    setEditBody(email.body.replace(/<p>/g, "").replace(/<\/p>/g, "\n\n").replace(/<br\/>/g, "\n").trim());
  };

  const saveEdit = async (emailId: string) => {
    const target = generatedEmails.find((e) => e.id === emailId);
    if (!target) return;

    const newEmail: GeneratedEmail = {
      ...target,
      subjectLine: editSubject,
      body: editBody
        .split(/\n\n+/)
        .map((p) => `<p>${p.replace(/\n/g, "<br/>").trim()}</p>`)
        .join("\n"),
      editedAt: new Date().toISOString(),
      approved: true,
    };

    await storage.upsert(storage.KEYS.emails, newEmail);
    setGeneratedEmails((prev) => prev.map((e) => (e.id === emailId ? newEmail : e)));
    setEditingId(null);
  };

  const toggleApprove = async (emailId: string) => {
    const target = generatedEmails.find((e) => e.id === emailId);
    if (!target) return;

    const toggled: GeneratedEmail = { ...target, approved: !target.approved };
    await storage.upsert(storage.KEYS.emails, toggled);
    setGeneratedEmails((prev) => prev.map((e) => (e.id === emailId ? toggled : e)));
    if (toggled.approved && campaign) {
      await logAudit("email_approved", "1 email approved", { campaignId: campaign.id, leadId: toggled.leadId });
    }
  };

  const approveAll = async () => {
    const updated = generatedEmails.map((e) => ({ ...e, approved: true }));
    await Promise.all(updated.map((e) => storage.upsert(storage.KEYS.emails, e)));
    setGeneratedEmails(updated);
    if (campaign) {
      await logAudit("email_approved", `${updated.length} emails approved`, { campaignId: campaign.id });
    }
  };

  // ── Step 2: Create drafts ──────────────────────────────────────────────────

  const handleCreateDrafts = async () => {
    if (!campaign) return;
    const approved = generatedEmails.filter((e) => e.approved);
    if (approved.length === 0) return;

    setDrafting(true);
    setStep("drafting");

    // Fetch a fresh snapshot right before drafting — leads/inboxes may have
    // changed since this page loaded (e.g. your partner connected an inbox).
    const currentLeads = await storage.get<Lead>(storage.KEYS.leads);
    const currentInboxes = await storage.get<Inbox>(storage.KEYS.inboxes);
    const currentLeadMap = new Map(currentLeads.map((l) => [l.id, l]));

    const approvedLeads = approved
      .map((e) => currentLeadMap.get(e.leadId))
      .filter(Boolean) as Lead[];

    // Distribute the plan across ALL active inboxes, connected or not — this
    // is what lets you set up 6 inboxes, generate/draft now, and connect them
    // one at a time afterward. Each item still only succeeds at the loop
    // below if its assigned inbox has a valid accessToken at that moment;
    // otherwise it's marked "failed" and can be retried once connected.
    const distribution = distributeLeads(approvedLeads, currentInboxes);
    const emailIdMap = new Map<string, string>(approved.map((e) => [e.leadId, e.id]));
    const queueItems = buildQueueItems(campaign, emailIdMap, distribution);

    await Promise.all(queueItems.map((item) => storage.upsert(storage.KEYS.queue, item)));

    setDraftProgress({ done: 0, total: queueItems.length, failed: 0 });

    let done = 0;
    let failed = 0;

    // Sequential on purpose — avoids hammering the Graph API rate limits
    for (const item of queueItems) {
      const inbox = currentInboxes.find((i) => i.id === item.inboxId);
      const email = approved.find((e) => e.id === item.emailId);
      const lead = currentLeadMap.get(item.leadId);

      if (!inbox?.refreshToken || !email || !lead) {
        failed++;
        await storage.upsert(storage.KEYS.queue, { ...item, status: "failed" });
        setDraftProgress((p) => ({ ...p, done: ++done, failed }));
        continue;
      }

      try {
        // Auto-refreshes if the cached access token is expired or close to
        // it — this is what removes the need to manually reconnect an
        // inbox before every campaign.
        const accessToken = await getValidAccessToken(inbox);

        const draftId = await createOutlookDraft(
          accessToken,
          {
            toEmail: lead.contactEmail,
            toName: lead.contactName,
            subject: email.subjectLine,
            bodyHtml: email.body,
          }
        );

        await storage.upsert(storage.KEYS.queue, { ...item, draftId, status: "drafted" });
        await storage.upsert(storage.KEYS.leads, { ...lead, status: "drafted" });
        await storage.upsert(storage.KEYS.inboxes, {
          ...inbox,
          draftsToday: inbox.draftsToday + 1,
        });

        await logAudit("draft_created", `Draft created in ${inbox.emailAddress}`, {
          campaignId: campaign.id,
          leadId: lead.id,
          inboxId: inbox.id,
        });
      } catch (err) {
        failed++;
        await storage.upsert(storage.KEYS.queue, { ...item, status: "failed" });
        console.error("Draft creation failed:", err);
      }

      setDraftProgress((p) => ({ ...p, done: ++done, failed }));
    }

    await storage.upsert(storage.KEYS.campaigns, {
      ...campaign,
      status: "active",
      launchedAt: new Date().toISOString(),
    });
    setDrafting(false);
    setStep("done");

    // Refresh local state to reflect drafted leads / updated draftsToday counts
    await Promise.all([loadLeads(), loadInboxes()]);
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

          {dataLoading ? (
            <p className="text-muted">{lang === "fr" ? "Chargement…" : "Loading…"}</p>
          ) : (
          <div className="flex-col gap-4">
            <div className="field">
              <label>{lang === "fr" ? "Campagne" : "Campaign"}</label>
              <select
                className="select"
                value={selectedCampaignId}
                onChange={(e) => setSelectedCampaignId(e.target.value)}
              >
                <option value="new">{lang === "fr" ? "+ Nouvelle campagne" : "+ New campaign"}</option>
                {campaignsList
                  .slice()
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.totalLeads} {lang === "fr" ? "contacts" : "contacts"})
                    </option>
                  ))}
              </select>
              {selectedCampaignId !== "new" && (
                <span className="text-muted text-sm">
                  {lang === "fr"
                    ? "Les nouveaux emails générés seront ajoutés à cette campagne existante."
                    : "Newly generated emails will be added to this existing campaign."}
                </span>
              )}
            </div>

            {selectedCampaignId === "new" && (
              <div className="field">
                <label>{tr("campaignName")}</label>
                <input
                  className="input"
                  placeholder={tr("campaignPlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}

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
              <span>
                {activeInboxes.length} active inbox{activeInboxes.length !== 1 ? "es" : ""} ·{" "}
                {connectedInboxCount} currently connected
                {connectedInboxCount < activeInboxes.length &&
                  (lang === "fr"
                    ? " — les autres échoueront jusqu'à ce que vous les connectiez"
                    : " — the rest will fail until you connect them")}
              </span>
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
          )}
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
              const lead = leadMap.get(email.leadId);
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
                setSelectedCampaignId("new");
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