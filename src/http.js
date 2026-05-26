#!/usr/bin/env node
/**
 * Gmail MCP Server — OAuth-native HTTP server
 *
 * Flow (founder-approved):
 *  1. User adds this server URL to claude.ai connector
 *  2. claude.ai detects OAuth required → shows "Login with Google"
 *  3. User clicks login → authorizes their Gmail
 *  4. Done — Gmail works in Claude, no extra steps
 */

import express from "express";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  listMessages, getMessage, getAttachment, sendEmail,
  listLabels, modifyLabels, trashMessage, getProfile, listThreads,
} from "./gmail.js";

// ─── Load .env ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [key, ...val] = line.split("=");
    if (key?.trim() && val.length) process.env[key.trim()] = val.join("=").trim();
  });
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT = process.env.PORT || 3000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

const GOOGLE_REDIRECT = `${BASE_URL}/callback`;

// ─── In-memory stores ─────────────────────────────────────────────────────────

const pendingAuth  = new Map(); // authState  → { redirect_uri, state, code_challenge }
const pendingCodes = new Map(); // authCode   → { accessToken }
const userTokens   = new Map(); // accessToken → Gmail OAuth tokens

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGoogleClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, GOOGLE_REDIRECT);
}

function buildAuthForUser(gmailTokens) {
  const client = makeGoogleClient();
  client.setCredentials(gmailTokens);
  return client;
}

function getAuthFromRequest(req, res) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || !userTokens.has(token)) {
    res.status(401)
      .setHeader("WWW-Authenticate", `Bearer realm="${BASE_URL}"`)
      .json({ error: "unauthorized", message: "Login at " + BASE_URL });
    return null;
  }

  return buildAuthForUser(userTokens.get(token));
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_, res) => res.sendStatus(200));

// ─── MCP OAuth Discovery ──────────────────────────────────────────────────────
// claude.ai reads this to know how to trigger login

app.get("/.well-known/oauth-authorization-server", (_, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["gmail"],
  });
});

// ─── OAuth: Authorization endpoint ───────────────────────────────────────────
// claude.ai redirects user here → we redirect to Google

app.get("/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const authState = crypto.randomBytes(16).toString("hex");

  pendingAuth.set(authState, { redirect_uri, state, code_challenge, code_challenge_method });

  const googleAuthUrl = makeGoogleClient().generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: authState,
  });

  res.redirect(googleAuthUrl);
});

// ─── OAuth: Google callback ───────────────────────────────────────────────────
// Google redirects here after user logs in

app.get("/callback", async (req, res) => {
  const { code, state: authState, error } = req.query;

  if (error) return res.status(400).send(`Google auth error: ${error}`);

  const pending = pendingAuth.get(authState);
  if (!pending) return res.status(400).send("Invalid or expired session. Please try again.");

  try {
    const client = makeGoogleClient();
    const { tokens: gmailTokens } = await client.getToken(code);

    // Create our Bearer token for claude.ai
    const accessToken = crypto.randomBytes(32).toString("hex");
    userTokens.set(accessToken, gmailTokens);

    // Get user email for display
    client.setCredentials(gmailTokens);
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });

    // Create auth code to send back to claude.ai
    const authCode = crypto.randomBytes(16).toString("hex");
    pendingCodes.set(authCode, accessToken);
    pendingAuth.delete(authState);

    // Redirect back to claude.ai with the code
    const redirectUrl = new URL(pending.redirect_uri);
    redirectUrl.searchParams.set("code", authCode);
    if (pending.state) redirectUrl.searchParams.set("state", pending.state);

    process.stderr.write(`[gmail-mcp] ✅ ${profile.data.emailAddress} authorized\n`);
    res.redirect(redirectUrl.toString());
  } catch (e) {
    res.status(500).send("Authorization failed: " + e.message);
  }
});

// ─── OAuth: Token endpoint ────────────────────────────────────────────────────
// claude.ai exchanges auth code for Bearer token

app.post("/token", (req, res) => {
  const { code, grant_type } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const accessToken = pendingCodes.get(code);
  if (!accessToken) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code not found or expired" });
  }

  pendingCodes.delete(code);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 604800, // 7 days
    scope: "gmail",
  });
});

// ─── MCP Server builder ───────────────────────────────────────────────────────

function buildMcpServer(auth) {
  const server = new McpServer({ name: "gmail-mcp", version: "1.0.0" });

  server.tool("get_profile", "Get Gmail account profile — email address and message count.", {}, async () => {
    const p = await getProfile(auth);
    return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
  });

  server.tool("list_emails", "Fetch emails from Gmail inbox. Supports Gmail search syntax.", {
    query: z.string().optional().default(""),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
    labelIds: z.array(z.string()).optional().default([]),
  }, async ({ query, maxResults, labelIds }) => {
    const msgs = await listMessages(auth, { query, maxResults, labelIds });
    return { content: [{ type: "text", text: JSON.stringify(msgs.map(m => ({
      id: m.id, from: m.from, to: m.to, subject: m.subject,
      date: m.date, snippet: m.snippet, hasAttachments: m.hasAttachments,
    })), null, 2) }] };
  });

  server.tool("read_email", "Read full content of an email by message ID.", {
    messageId: z.string(),
  }, async ({ messageId }) => {
    return { content: [{ type: "text", text: JSON.stringify(await getMessage(auth, messageId), null, 2) }] };
  });

  server.tool("send_email", "Send an email from your Gmail account.", {
    to: z.string(), subject: z.string(), body: z.string(),
    cc: z.string().optional(), bcc: z.string().optional(),
    replyToMessageId: z.string().optional(),
  }, async (args) => {
    const r = await sendEmail(auth, args);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...r }, null, 2) }] };
  });

  server.tool("search_emails", "Search emails using Gmail search syntax.", {
    query: z.string(),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
  }, async ({ query, maxResults }) => {
    return { content: [{ type: "text", text: JSON.stringify(await listMessages(auth, { query, maxResults }), null, 2) }] };
  });

  server.tool("list_labels", "List all Gmail labels.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(await listLabels(auth), null, 2) }] };
  });

  server.tool("label_email", "Add or remove labels on an email.", {
    messageId: z.string(),
    addLabels: z.array(z.string()).optional().default([]),
    removeLabels: z.array(z.string()).optional().default([]),
  }, async ({ messageId, addLabels, removeLabels }) => {
    return { content: [{ type: "text", text: JSON.stringify(await modifyLabels(auth, messageId, { addLabels, removeLabels }), null, 2) }] };
  });

  server.tool("trash_email", "Move an email to trash.", {
    messageId: z.string(),
  }, async ({ messageId }) => {
    return { content: [{ type: "text", text: JSON.stringify(await trashMessage(auth, messageId), null, 2) }] };
  });

  server.tool("list_threads", "List email threads/conversations.", {
    query: z.string().optional().default(""),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
  }, async ({ query, maxResults }) => {
    return { content: [{ type: "text", text: JSON.stringify(await listThreads(auth, { query, maxResults }), null, 2) }] };
  });

  server.tool("download_attachment", "Download an email attachment as base64.", {
    messageId: z.string(), attachmentId: z.string(), filename: z.string(),
  }, async ({ messageId, attachmentId, filename }) => {
    const att = await getAttachment(auth, messageId, attachmentId);
    return { content: [{ type: "text", text: JSON.stringify({ filename, ...att }, null, 2) }] };
  });

  return server;
}

// ─── StreamableHTTP MCP endpoints ────────────────────────────────────────────

const httpSessions = new Map();

app.post("/mcp", async (req, res) => {
  const auth = getAuthFromRequest(req, res);
  if (!auth) return;

  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? httpSessions.get(sessionId) : null;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdHeader: "mcp-session-id" });
    const server = buildMcpServer(auth);
    transport.onclose = () => httpSessions.delete(transport.sessionId);
    await server.connect(transport);
    if (transport.sessionId) httpSessions.set(transport.sessionId, transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = httpSessions.get(sessionId);
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid or missing mcp-session-id" });
  }
});

app.delete("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) httpSessions.delete(sessionId);
  res.sendStatus(200);
});

// ─── SSE MCP endpoints (fallback) ────────────────────────────────────────────

const sseSessions = new Map();

app.get("/sse", async (req, res) => {
  const auth = getAuthFromRequest(req, res);
  if (!auth) return;

  const server = buildMcpServer(auth);
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  res.on("close", () => { sseSessions.delete(transport.sessionId); server.close(); });
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseSessions.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "gmail-mcp", base_url: BASE_URL }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  process.stderr.write(`[gmail-mcp] Running on ${BASE_URL}\n`);
  process.stderr.write(`[gmail-mcp] MCP endpoint: ${BASE_URL}/mcp\n`);
  process.stderr.write(`[gmail-mcp] OAuth discovery: ${BASE_URL}/.well-known/oauth-authorization-server\n`);
});
