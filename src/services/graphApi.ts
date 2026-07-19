import type { Inbox } from "../types";
import { storage } from "./storage";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const CLIENT_ID = process.env.REACT_APP_MS_CLIENT_ID || "";
const SCOPES = "Mail.ReadWrite Mail.Send User.Read offline_access";

// Same backend that serves /generate — it now also handles the OAuth token
// exchange server-side (see api.py), which is what unlocks 90-day refresh
// tokens instead of the 24-hour cap Microsoft imposes on browser-only (SPA)
// token exchanges.
const API_BASE = process.env.REACT_APP_AI_API_URL || "";

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number; // seconds
}

export function signInInbox(loginHint?: string): Promise<TokenResult> {
  return new Promise((resolve, reject) => {
    if (!API_BASE) {
      reject(new Error("REACT_APP_AI_API_URL is not set — required for the OAuth callback."));
      return;
    }

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: `${API_BASE}/auth/callback`,
      scope: SCOPES,
      ...(loginHint ? { login_hint: loginHint } : {}),
    });

    const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
    const popup = window.open(url, "msauth", "width=500,height=700");

    let settled = false;
    let pollTimer: number | undefined;
    let hardTimeout: number | undefined;

    const cleanup = () => {
      window.removeEventListener("message", handler);
      if (pollTimer) window.clearInterval(pollTimer);
      if (hardTimeout) window.clearTimeout(hardTimeout);
    };

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "ms_auth_success") {
        settled = true;
        cleanup();
        resolve({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresIn: data.expiresIn ?? 3600,
        });
        popup?.close();
      } else if (data.type === "ms_auth_error") {
        settled = true;
        cleanup();
        reject(new Error(data.error || "Authentication failed"));
        popup?.close();
      }
    };

    window.addEventListener("message", handler);

    // Detects the popup closing (whether the user cancels manually, or it
    // finishes and closes itself) without a message ever arriving — catches
    // edge cases the message listener alone would miss.
    pollTimer = window.setInterval(() => {
      if (popup?.closed && !settled) {
        settled = true;
        cleanup();
        reject(new Error("Sign-in window was closed before completing."));
      }
    }, 500);

    // Generous last-resort cap — logins involving MFA or extra verification
    // steps can legitimately take a couple of minutes, so this only exists
    // to prevent an indefinite hang, not to rush the user.
    hardTimeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Timeout — sign-in took too long."));
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Exchanges a refresh token for a new access token via the backend (which
 * holds the client secret) instead of calling Microsoft directly. This is
 * what gives refreshed tokens the full ~90-day sliding-window lifetime
 * instead of the 24-hour cap that applies to browser-direct SPA exchanges.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  if (!API_BASE) throw new Error("REACT_APP_AI_API_URL is not set — required for token refresh.");

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Token refresh failed");

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn ?? 3600,
  };
}

/**
 * Returns a valid access token for this inbox, silently refreshing (and
 * persisting the refreshed token to storage) if the current one is missing
 * or close to expiring. Every Graph API call should go through this instead
 * of touching inbox.accessToken directly.
 *
 * Throws if there's no refresh token on file (never connected) or if the
 * refresh itself fails (refresh token expired/revoked — with the backend
 * confidential-client flow this should now only happen after ~90 days of
 * inactivity, or if access was explicitly revoked).
 */
export async function getValidAccessToken(inbox: Inbox): Promise<string> {
  const now = Date.now();
  const expiresAt = inbox.tokenExpiresAt ? new Date(inbox.tokenExpiresAt).getTime() : 0;
  const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

  if (inbox.accessToken && expiresAt - REFRESH_BUFFER_MS > now) {
    return inbox.accessToken; // still valid, no network call needed
  }

  if (!inbox.refreshToken) {
    throw new Error(`${inbox.emailAddress} has never been connected — click Connect first.`);
  }

  try {
    const result = await refreshAccessToken(inbox.refreshToken);
    const tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();

    await storage.upsert(storage.KEYS.inboxes, {
      ...inbox,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || inbox.refreshToken,
      tokenExpiresAt,
      needsReconnect: false,
    });

    return result.accessToken;
  } catch (err) {
    // Most commonly this happens when the stored refresh token was issued
    // under a different auth flow than the app currently uses (e.g. an
    // inbox connected before the SPA → backend-mediated OAuth switch) — no
    // automatic recovery exists for that, a real reconnect is required.
    // Flagging it here means it shows up on the Inboxes page instead of
    // only in console logs.
    await storage.upsert(storage.KEYS.inboxes, { ...inbox, needsReconnect: true });
    throw err;
  }
}

export interface DraftPayload {
  toEmail: string;
  toName: string;
  subject: string;
  bodyHtml: string;
}

export async function createOutlookDraft(accessToken: string, payload: DraftPayload): Promise<string> {
  const res = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: payload.subject,
      body: { contentType: "HTML", content: payload.bodyHtml },
      toRecipients: [{ emailAddress: { address: payload.toEmail, name: payload.toName } }],
      isDraft: true,
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || res.status); }
  return (await res.json()).id;
}

export async function sendDraft(accessToken: string, draftId: string): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/me/messages/${draftId}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || res.status); }
}