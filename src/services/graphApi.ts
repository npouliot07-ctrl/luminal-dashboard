import type { Inbox } from "../types";
import { storage } from "./storage";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const CLIENT_ID = process.env.REACT_APP_MS_CLIENT_ID || "";
const REDIRECT_URI = process.env.REACT_APP_MS_REDIRECT_URI || "http://localhost:3000/auth-callback.html";
const SCOPES = "Mail.ReadWrite Mail.Send User.Read offline_access";

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number; // seconds
}

export function signInInbox(loginHint?: string): Promise<TokenResult> {
  return new Promise((resolve, reject) => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    sessionStorage.setItem("pkce_verifier", verifier);

    challenge.then(ch => {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: ch,
        code_challenge_method: "S256",
        ...(loginHint ? { login_hint: loginHint } : {}),
      });

      const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
      const popup = window.open(url, "msauth", "width=500,height=700");

      const handler = (event: MessageEvent) => {
        if (!event.data?.includes("code=")) return;
        window.removeEventListener("message", handler);
        const urlParams = new URLSearchParams(event.data.split("?")[1] || event.data.split("#")[1]);
        const code = urlParams.get("code");
        if (!code) { reject(new Error("No code")); return; }
        exchangeCode(code, verifier).then(resolve).catch(reject);
        popup?.close();
      };

      window.addEventListener("message", handler);
      setTimeout(() => { window.removeEventListener("message", handler); reject(new Error("Timeout")); }, 120000);
    });
  });
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResult> {
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "Token exchange failed");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Exchanges a refresh token for a new access token, without any user
 * interaction. Microsoft's public-client refresh flow doesn't need the
 * PKCE code_verifier — only the original authorization-code exchange does.
 * Requires the "offline_access" scope to have been granted on connect
 * (it already is — see SCOPES above).
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPES,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "Token refresh failed");
  return {
    accessToken: data.access_token,
    // Microsoft may or may not rotate the refresh token on each use —
    // fall back to reusing the old one if a new one wasn't returned.
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Returns a valid access token for this inbox, silently refreshing (and
 * persisting the refreshed token to storage) if the current one is missing
 * or close to expiring. This is what makes reconnecting a one-time thing
 * instead of something you have to redo every hour: as long as the refresh
 * token is still valid, every Graph API call goes through this instead of
 * touching inbox.accessToken directly.
 *
 * Throws if there's no refresh token on file (never connected) or if the
 * refresh itself fails (refresh token expired/revoked — this does happen
 * eventually, typically after ~90 days of inactivity, and at that point a
 * manual reconnect really is required).
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

  const result = await refreshAccessToken(inbox.refreshToken);
  const tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();

  await storage.upsert(storage.KEYS.inboxes, {
    ...inbox,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenExpiresAt,
  });

  return result.accessToken;
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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