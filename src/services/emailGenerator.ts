import type { Lead, GeneratedEmail } from "../types";
import { nanoid } from "../utils/nanoid";

const AI_API_URL = process.env.REACT_APP_AI_API_URL || "";

export function formatBodyAsHtml(plainText: string): string {
  return plainText
    .split(/\n\n+/)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>").trim()}</p>`)
    .join("\n");
}

export async function generateEmail(lead: Lead, generator = "Nathaniel Pouliot"): Promise<GeneratedEmail> {
  if (!AI_API_URL) throw new Error("REACT_APP_AI_API_URL not set in .env");

  const res = await fetch(`${AI_API_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lead: { ...lead, generator } }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API error for ${lead.contactEmail}: ${err}`);
  }

  const data: { subject: string; body: string } = await res.json();

  return {
    id: nanoid(),
    leadId: lead.id,
    subjectLine: data.subject.trim(),
    body: formatBodyAsHtml(data.body),
    generatedAt: new Date().toISOString(),
    approved: false,
  };
}

export async function generateEmailBatch(
  leads: Lead[],
  onProgress: (done: number, total: number) => void,
  generator = "Nathaniel Pouliot"
): Promise<GeneratedEmail[]> {
  const results: GeneratedEmail[] = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((lead) => generateEmail(lead, generator))
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        console.error("Generation failed:", result.reason);
      }
    }

    onProgress(Math.min(i + CONCURRENCY, leads.length), leads.length);
  }

  return results;
}
