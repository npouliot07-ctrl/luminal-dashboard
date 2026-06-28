# Outreach Dashboard

Cold email outreach dashboard — imports leads from CSV, generates personalised emails via your AI API, creates Outlook drafts via Microsoft Graph, and manages scheduled sending across multiple inboxes.

## Quick start

```bash
npm install
cp .env.example .env   # fill in your values
npm start
```

Opens at http://localhost:3000

---

## Setup checklist

### 1. Azure App Registration (one-time)

1. Go to [portal.azure.com](https://portal.azure.com)
2. Azure Active Directory → App registrations → New registration
3. Name: "Outreach Dashboard"
4. Redirect URI: `http://localhost:3000/auth/callback` (Single Page Application)
5. API permissions → Add: `Mail.ReadWrite`, `Mail.Send` (both Delegated)
6. Copy the **Application (client) ID** → paste in `.env` as `REACT_APP_MS_CLIENT_ID`

### 2. Connect each inbox

1. Go to **Inboxes** in the dashboard
2. Click **Add inbox** → enter the @outlook.com address
3. Click **Connect** → Microsoft OAuth popup
4. Sign in as that account and approve permissions
5. Repeat for all 11 inboxes

### 3. Connect your AI API

- Set `REACT_APP_AI_API_URL` to your Streamlit/Python API URL
- Your API must accept `POST /generate` with body `{ lead: Lead }` and return `{ subject: string, body: string }`
- Paragraph breaks in `body` should use `\n\n`

---

## Project structure

```
src/
  types/          — all TypeScript interfaces (Lead, Inbox, Campaign, etc.)
  services/
    storage.ts        — localStorage persistence layer
    graphApi.ts       — Microsoft Graph API (OAuth + draft creation + send)
    emailGenerator.ts — calls your AI API, formats HTML output
    routingEngine.ts  — weighted distribution + ramp logic
    compliance.ts     — suppression list, audit log
  utils/
    csvParser.ts  — CSV → Lead objects, deduplication
    nanoid.ts     — ID generation
  pages/
    LeadsPage.tsx     — CSV upload, suppression check, lead table
    CampaignPage.tsx  — configure, generate, preview/edit, create drafts
    InboxPage.tsx     — inbox management, OAuth connect, ramp settings
    QueuePage.tsx     — send queue, auto/manual toggle, send now
    CompliancePage.tsx — suppression list, audit log
  styles/
    global.css    — design system (tokens, buttons, tables, badges)
```

---

## CSV format

Your CSV needs these columns (names are flexible — the parser looks for keywords):

| Column | Accepted names |
|--------|---------------|
| Email  | `email`, `contact_email` |
| Name   | `name`, `contact_name`, `first_name` |
| Company | `company`, `company_name`, `organization` |
| Website | `website`, `url`, `domain`, `site` |

---

## Daily ramp

Each inbox has its own `dailyLimit` (current ceiling) and `rampRate` (+0.5/day default).
Limits increment automatically at midnight. You can edit both per inbox in the Inboxes screen.

Starting values: `dailyLimit: 5`, `rampRate: 0.5`

---

## Scaling beyond 11 inboxes

The routing engine is purely math — adding inboxes just expands the distribution pool.
To add inbox #12: Inboxes → Add inbox → Connect. No code changes needed.

---

## ⚠️ Security note

OAuth token exchange (code → tokens) should happen server-side in production to protect your client secret. The current implementation is frontend-only and suitable for personal/internal use. For a team deployment, add a small proxy server (Express or FastAPI) to handle the token exchange.
