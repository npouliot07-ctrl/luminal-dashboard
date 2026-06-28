import Papa from "papaparse";
import type { Lead } from "../types";
import { nanoid } from "./nanoid";

/**
 * Parse a CSV file into Lead objects.
 *
 * Expected CSV columns (case-insensitive):
 *   email, name (or contact_name), company (or company_name), website (or url)
 *
 * Returns { leads, errors } where errors are rows that couldn't be parsed.
 */

interface RawRow {
  [key: string]: string;
}

function normalizeKey(row: RawRow, ...candidates: string[]): string {
  const keys = Object.keys(row).map((k) => k.toLowerCase().trim());
  for (const candidate of candidates) {
    const match = keys.find((k) => k === candidate || k.includes(candidate));
    if (match) {
      const originalKey = Object.keys(row).find(
        (k) => k.toLowerCase().trim() === match
      );
      return originalKey ? row[originalKey] : "";
    }
  }
  return "";
}

export async function parseCsvToLeads(
  file: File
): Promise<{ leads: Lead[]; errors: string[] }> {
  return new Promise((resolve) => {
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      beforeFirstChunk: (chunk) => {
        const lines = chunk.split("\n");
        if (lines[0].startsWith(",")) lines[0] = lines[0].substring(1);
        return lines.join("\n");
      },
      transformHeader: (header) => header.trim().replace(/^,/, ""),
      complete: (results) => {
        const leads: Lead[] = [];
        const errors: string[] = [];

        for (const [i, row] of results.data.entries()) {
          const email = normalizeKey(row, "email", "contact_email");
          const name = normalizeKey(row, "name", "contact_name", "first_name");
          const company = normalizeKey(row, "company", "company_name", "organization");
          const website = normalizeKey(row, "website", "url", "domain", "site");

          if (!email || !email.includes("@")) {
            errors.push(`Row ${i + 2}: missing or invalid email`);
            continue;
          }

          leads.push({
            id: nanoid(),
            companyName: company || "Unknown",
            contactName: name || company || "",
            contactEmail: email.toLowerCase().trim(),
            websiteUrl: website || "",
            sourceFile: file.name,
            status: "new",
            suppressed: false,
            createdAt: new Date().toISOString(),
          });
        }

        resolve({ leads, errors });
      },
      error: (err) => {
        resolve({ leads: [], errors: [err.message] });
      },
    });
  });
}

/**
 * Deduplicate leads by email — keeps the first occurrence.
 */
export function deduplicateLeads(
  incoming: Lead[],
  existing: Lead[]
): { unique: Lead[]; duplicates: number } {
  const existingEmails = new Set(existing.map((l) => l.contactEmail));
  const seen = new Set<string>();
  const unique: Lead[] = [];
  let duplicates = 0;

  for (const lead of incoming) {
    if (existingEmails.has(lead.contactEmail) || seen.has(lead.contactEmail)) {
      duplicates++;
    } else {
      unique.push(lead);
      seen.add(lead.contactEmail);
    }
  }

  return { unique, duplicates };
}
