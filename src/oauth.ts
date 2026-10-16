import { randomId, randomToken, secretMatches, sha256 } from "./crypto.js";
import { addMinutes, iso } from "./time.js";
import type { Env } from "./types.js";

type OAuthClient = {
  client_id: string;
  redirect_uris_json: string;
};

type OAuthCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
};

export async function handleOAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = url.origin;

  if (
    url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    return json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["heartbeat"],
      bearer_methods_supported: ["header"],
    });
  }

  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["heartbeat"],
    });
  }

  if (url.pathname === "/oauth/register" && request.method === "POST") {
    const payload = (await request.json()) as Record<string, unknown>;
    const redirectUris = Array.isArray(payload.redirect_uris)
      ? payload.redirect_uris.filter((item): item is string => typeof item === "string")
      : [];
    if (!redirectUris.length || !redirectUris.every(validRedirectUri)) {
      return oauthError("invalid_redirect_uri", 400);
    }
    const staleBefore = iso(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await env.DB.prepare(
      `DELETE FROM oauth_clients
       WHERE created_at < ?
         AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
         AND client_id NOT IN (SELECT client_id FROM oauth_codes WHERE used_at IS NULL)`,
    )
      .bind(staleBefore)
      .run();
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_clients").first<{
      count: number;
    }>();
    if ((count?.count ?? 0) >= 100) return oauthError("registration_limit_reached", 429);
    const clientId = randomId("client");
    await env.DB.prepare(
      `INSERT INTO oauth_clients (client_id, redirect_uris_json, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(clientId, JSON.stringify(redirectUris), iso(new Date()))
      .run();
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      201,
    );
  }

  if (url.pathname === "/oauth/authorize") {
    if (request.method === "GET") return authorizeForm(url, env);
    if (request.method === "POST") return authorizeSubmit(request, env);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return exchangeToken(request, env);
  }

  return null;
}

export async function authorizeMcp(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = /^Bearer\s+(.+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return false;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ expires_at: string; revoked_at: string | null }>();
  return Boolean(row && !row.revoked_at && row.expires_at > iso(new Date()));
}

export async function revokeAllMcpTokens(env: Env, now = new Date()): Promise<void> {
  await env.DB.prepare(
    "UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL",
  )
    .bind(iso(now))
    .run();
}

export function mcpUnauthorized(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json(
    { error: "unauthorized", error_description: "Connect the private heartbeat plugin." },
    401,
    {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  );
}

async function authorizeForm(url: URL, env: Env): Promise<Response> {
  const params = authorizationParams(url.searchParams);
  if (!params) return oauthError("invalid_request", 400);
  const client = await loadClient(env, params.clientId);
  if (!client || !clientRedirects(client).includes(params.redirectUri)) {
    return oauthError("invalid_client", 400);
  }
  return new Response(
    `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>連接沉淵自主心跳</title>
    <style>body{font:16px system-ui;background:#f5f2ea;color:#25221d;margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(420px,calc(100% - 40px));background:#fff;padding:28px;border-radius:18px;box-shadow:0 16px 60px #5d4c3330}h1{font-size:24px;margin-top:0}p{line-height:1.55;color:#655f55}label{display:grid;gap:8px;margin:22px 0}input{font:inherit;padding:12px;border:1px solid #b9b1a4;border-radius:10px}button{font:inherit;font-weight:650;padding:12px 16px;border:0;border-radius:10px;background:#2d2923;color:#fff;width:100%}</style>
    <main><h1>連接沉淵自主心跳</h1><p>這會讓目前的官方 ChatGPT 連線讀取心跳狀態、提交沉淵在官方回合做出的決策，以及控制暫停開關。它不會取得岑序的寫入權限。</p>
    <form method="post">
      ${hidden("client_id", params.clientId)}${hidden("redirect_uri", params.redirectUri)}${hidden("response_type", "code")}${hidden("code_challenge", params.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("scope", params.scope)}${hidden("state", params.state)}
      <label>私人連接密語<input type="password" name="passphrase" required autocomplete="current-password"></label>
      <button type="submit">授權連接</button>
    </form></main></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function authorizeSubmit(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const params = authorizationParams(form);
  if (!params) return oauthError("invalid_request", 400);
  const client = await loadClient(env, params.clientId);
  if (!client || !clientRedirects(client).includes(params.redirectUri)) {
    return oauthError("invalid_client", 400);
  }
  const attemptKey = await sha256(
    `${request.headers.get("cf-connecting-ip") ?? "unknown"}:${params.clientId}`,
  );
  const windowStart = iso(new Date(Date.now() - 15 * 60 * 1000));
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM oauth_auth_attempts
     WHERE attempt_key = ? AND attempted_at >= ? AND success = 0`,
  )
    .bind(attemptKey, windowStart)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 5) return oauthError("temporarily_locked", 429);
  const passphrase = String(form.get("passphrase") ?? "");
  const accepted = await secretMatches(passphrase, env.MCP_CONNECT_PASSPHRASE);
  await env.DB.prepare(
    `INSERT INTO oauth_auth_attempts (id, attempt_key, attempted_at, success)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(randomId("auth"), attemptKey, iso(new Date()), accepted ? 1 : 0)
    .run();
  if (!accepted) {
    return new Response("授權密語不正確。", { status: 403 });
  }
  const code = randomToken();
  await env.DB.prepare(
    `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256(code),
      params.clientId,
      params.redirectUri,
      params.codeChallenge,
      params.scope,
      iso(addMinutes(new Date(), 10)),
    )
    .run();
  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return Response.redirect(redirect, 303);
}

async function exchangeToken(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  if (form.get("grant_type") !== "authorization_code") {
    return oauthError("unsupported_grant_type", 400);
  }
  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeHash = await sha256(code);
  const stored = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
    .bind(codeHash)
    .first<OAuthCode>();
  const now = new Date();
  if (
    !stored ||
    stored.used_at ||
    stored.expires_at <= iso(now) ||
    stored.client_id !== clientId ||
    stored.redirect_uri !== redirectUri ||
    (await sha256(verifier)) !== stored.code_challenge
  ) {
    return oauthError("invalid_grant", 400);
  }
  const accessToken = randomToken(48);
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?")
      .bind(iso(now), codeHash),
    env.DB.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(await sha256(accessToken), clientId, stored.scope, iso(now), iso(expiresAt)),
  ]);
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
    scope: stored.scope,
  });
}

function authorizationParams(source: URLSearchParams | FormData): {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
} | null {
  const get = (name: string) => String(source.get(name) ?? "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  const scope = get("scope") || "heartbeat";
  const state = get("state");
  if (
    !clientId ||
    !redirectUri ||
    get("response_type") !== "code" ||
    get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) ||
    scope !== "heartbeat"
  ) {
    return null;
  }
  return { clientId, redirectUri, codeChallenge, scope, state };
}

async function loadClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<OAuthClient>();
}

function clientRedirects(client: OAuthClient): string[] {
  const parsed = JSON.parse(client.redirect_uris_json) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthError(error: string, status: number): Response {
  return json({ error }, status);
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
