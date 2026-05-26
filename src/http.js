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
import os from "os";
import {
  listMessages, getMessage, getAttachment, sendEmail,
  listLabels, modifyLabels, trashMessage, getProfile, listThreads,
  fetchAttachmentFromUrl,
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

const CLIENT_ID = process.env.WEB_CLIENT_ID;
const CLIENT_SECRET = process.env.WEB_CLIENT_SECRET;
let BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
if (BASE_URL.endsWith("/")) {
  BASE_URL = BASE_URL.slice(0, -1);
}
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
  // Check Authorization header first
  let token = "";
  const header = req.headers["authorization"] || "";
  
  if (header.startsWith("Bearer ")) {
    token = header.slice(7);
  } else if (req.query?.token) {
    // Fall back to query parameter (from ?token=...)
    token = req.query.token;
  }

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

// ─── Landing page ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Gmail MCP — Connect your Gmail to Claude</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 48px 40px; max-width: 480px;
            width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    .icon { font-size: 3rem; margin-bottom: 16px; }
    h1 { font-size: 1.6rem; font-weight: 700; color: #111; margin-bottom: 8px; }
    p { color: #666; font-size: 0.95rem; line-height: 1.6; margin-bottom: 32px; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 12px;
           background: white; border: 2px solid #e0e0e0; border-radius: 10px;
           padding: 14px 24px; font-size: 1rem; font-weight: 500; color: #333;
           text-decoration: none; transition: all 0.2s; cursor: pointer; width: 100%; }
    .btn:hover { border-color: #4285f4; color: #4285f4; box-shadow: 0 2px 12px rgba(66,133,244,0.15); }
    .btn img { width: 22px; height: 22px; }
    .features { display: flex; flex-direction: column; gap: 8px; margin-top: 32px;
                text-align: left; border-top: 1px solid #f0f0f0; padding-top: 28px; }
    .feature { display: flex; align-items: center; gap: 10px; font-size: 0.88rem; color: #555; }
    .dot { width: 6px; height: 6px; background: #4285f4; border-radius: 50%; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📧</div>
    <h1>Gmail for Claude</h1>
    <p>Connect your Gmail account to Claude AI. Read, send, search and manage your emails using natural language.</p>

    <a href="/auth/login" class="btn">
      <img src="https://www.google.com/favicon.ico" alt="Google">
      Continue with Google
    </a>

    <div class="features">
      <div class="feature"><div class="dot"></div>Read and search your emails</div>
      <div class="feature"><div class="dot"></div>Send emails and attachments</div>
      <div class="feature"><div class="dot"></div>Manage labels and threads</div>
      <div class="feature"><div class="dot"></div>Each user connects their own Gmail</div>
      <div class="feature"><div class="dot"></div>We never store your password</div>
    </div>
  </div>
</body>
</html>`);
});

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

// Direct login from landing page
app.get("/auth/login", (req, res) => {
  const authState = "direct_" + crypto.randomBytes(16).toString("hex");
  pendingAuth.set(authState, { redirect_uri: `${BASE_URL}/success`, state: null });
  const googleAuthUrl = makeGoogleClient().generateAuthUrl({
    access_type: "offline", scope: SCOPES, prompt: "consent", state: authState,
  });
  res.redirect(googleAuthUrl);
});

// MCP OAuth authorize (used by claude.ai automatically)
app.get("/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const authState = crypto.randomBytes(16).toString("hex");
  pendingAuth.set(authState, { redirect_uri, state, code_challenge, code_challenge_method });
  const googleAuthUrl = makeGoogleClient().generateAuthUrl({
    access_type: "offline", scope: SCOPES, prompt: "consent", state: authState,
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
    if (pending.redirect_uri && !pending.redirect_uri.endsWith("/success")) {
      const redirectUrl = new URL(pending.redirect_uri);
      redirectUrl.searchParams.set("code", authCode);
      if (pending.state) redirectUrl.searchParams.set("state", pending.state);
      process.stderr.write(`[gmail-mcp] ✅ ${profile.data.emailAddress} authorized\n`);
      res.redirect(redirectUrl.toString());
    } else {
      // Direct login - show success page
      process.stderr.write(`[gmail-mcp] ✅ ${profile.data.emailAddress} authorized\n`);
      const serverUrlWithToken = `${BASE_URL}/mcp?token=${accessToken}`;
      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Authorization Successful</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 48px 40px; max-width: 520px;
            width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .success-icon { font-size: 3rem; margin-bottom: 16px; text-align: center; }
    h1 { font-size: 1.6rem; font-weight: 700; color: #111; margin-bottom: 8px; text-align: center; }
    p { color: #666; font-size: 0.95rem; line-height: 1.6; }
    .email { color: #4285f4; font-weight: 600; margin: 16px 0; text-align: center; }
    .section { margin-top: 32px; }
    .section-title { font-size: 0.85rem; font-weight: 600; color: #999; text-transform: uppercase; margin-bottom: 12px; }
    .code-block { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px;
                  font-family: 'Courier New', monospace; font-size: 0.85rem; color: #333;
                  word-break: break-all; cursor: pointer; transition: all 0.2s; min-height: 60px;
                  display: flex; align-items: center; }
    .code-block:hover { background: #efefef; border-color: #d0d0d0; }
    .copy-hint { font-size: 0.75rem; color: #999; margin-top: 8px; }
    .instructions { background: #f0f7ff; border-left: 4px solid #4285f4; padding: 12px; border-radius: 4px;
                    font-size: 0.9rem; color: #1a5490; margin-top: 8px; }
    .footer { text-align: center; margin-top: 24px; color: #999; font-size: 0.9rem; border-top: 1px solid #f0f0f0; padding-top: 24px; }
    .security-note { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 10px;
                     font-size: 0.85rem; color: #856404; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">✅</div>
    <h1>Authorization Successful!</h1>
    <p>You have successfully connected your Gmail account.</p>
    <div class="email">${profile.data.emailAddress}</div>

    <div class="section">
      <div class="section-title">📋 Add to Claude</div>
      <p style="margin-bottom: 12px;">Copy this URL and add it to Claude's MCP Server settings:</p>
      <div class="code-block" onclick="navigator.clipboard.writeText('${serverUrlWithToken}'); this.innerHTML='✓ Copied to clipboard!'; setTimeout(() => { this.innerHTML='${serverUrlWithToken}'; }, 2000);">${serverUrlWithToken}</div>
      <div class="copy-hint">Click to copy</div>
      <div class="security-note">
        ⚠️ <strong>Security:</strong> This URL contains your authentication token. Keep it private and don't share it with others.
      </div>
      <div class="instructions">
        <strong>Steps to Add in Claude:</strong><br>
        1. Go to <strong>claude.ai</strong> or Claude app<br>
        2. Settings → <strong>Models & Tools</strong><br>
        3. Select an AI model (e.g., Claude 3.5 Sonnet)<br>
        4. Scroll to <strong>"MCP Servers"</strong> section<br>
        5. Click <strong>"Add Server"</strong> or <strong>"Edit Settings"</strong><br>
        6. Paste the URL above into the "Server URL" field<br>
        7. Click <strong>"Save" or "Connect"</strong><br>
        8. Done! You can now ask Claude to read, send, and manage your emails
      </div>
    </div>

    <div class="section">
      <div class="section-title">💡 What You Can Do</div>
      <p style="font-size: 0.9rem; color: #666;">
        • Read and search emails<br>
        • Send emails with attachments<br>
        • Manage labels and threads<br>
        • Download attachments<br>
        • Use natural language with Claude to automate email tasks
      </p>
    </div>

    <div class="section">
      <div class="section-title">📎 Sending Emails With Files</div>
      <p style="font-size: 0.9rem; color: #666;">
        <strong>💻 Claude Desktop & Code (Direct Filesystem):</strong><br>
        Tell Claude: "Send ~/Downloads/trail1.pdf to user@example.com"<br>
        Claude reads the file directly and sends it!<br><br>
        <strong>🌐 Browser Claude (File Upload):</strong><br>
        Tell Claude you want to send a file, upload it in chat, and Claude sends it via Gmail.<br><br>
        <strong>Supported Files:</strong> PDF, CSV, XLSX, DOCX, Images (JPG, PNG), and more!
      </p>
    </div>

    <div class="footer">
      <p>Your Gmail is now connected and ready to use with Claude AI.</p>
    </div>
  </div>
</body>
</html>`);
    }
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

  server.tool("help_send_email_with_attachment", "Get instructions on how to send an email with a file attachment.", {}, async () => {
    return { content: [{ type: "text", text: `📧 HOW TO SEND EMAIL WITH ATTACHMENT:

⭐ EASIEST METHOD (Claude Desktop & Code):
Use the 'send_email_with_local_file' tool to send files directly from your computer:
- Tell me: "Send ~/Downloads/report.pdf to user@example.com"
- I'll read the file and send it as an attachment!
- Supports: ~/Downloads/file.pdf, /Users/username/Documents/file.doc, etc.

Example:
"Send ~/Downloads/trail1.csv to chhotaladu@gmail.com with subject 'Here is the data'"

ALTERNATIVE (Web Chat):
If using browser-based Claude, use 'send_email_with_file':
1. Upload file in chat (paperclip icon)
2. I'll send it with the base64-encoded content

SUPPORTED FILE TYPES:
- Documents: PDF, DOCX, DOC, XLS, XLSX, PPT, PPTX
- Images: JPG, PNG, GIF, BMP
- Data: CSV, JSON, XML
- Archives: ZIP, RAR
- And any other file type!
` }] };
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

  server.tool("send_email", "Send an email from your Gmail account. Supports attachments.", {
    to: z.string(), subject: z.string(), body: z.string(),
    cc: z.string().optional(), bcc: z.string().optional(),
    replyToMessageId: z.string().optional(),
    attachments: z.array(z.object({
      filename: z.string().describe("File name e.g. report.pdf"),
      mimeType: z.string().describe("MIME type e.g. application/pdf, image/png"),
      data: z.string().describe("Base64-encoded file content"),
    })).optional().default([]).describe("Files to attach to the email"),
  }, async (args) => {
    const r = await sendEmail(auth, args);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...r }, null, 2) }] };
  });

  server.tool("send_email_with_local_file", "Send an email with a local file from the computer where this MCP server is running. IMPORTANT: Even if this server is connected via ngrok or a remote URL, it runs locally on the user's computer, so you MUST call this tool when the user asks to attach a local file (e.g., ~/Downloads/contact.png). Do not assume it cannot access local files.", {
    to: z.string().describe("Recipient email address (e.g. user@example.com)"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body/message text"),
    filePath: z.string().describe("Full path to the file on your computer (e.g. ~/Downloads/report.pdf or /Users/username/Downloads/file.csv). Supports ~ for home directory"),
    cc: z.string().optional().describe("CC recipient email address (optional)"),
    bcc: z.string().optional().describe("BCC recipient email address (optional)"),
  }, async ({ to, subject, body, filePath, cc, bcc }) => {
    try {
      // Expand ~ to home directory
      const expandedPath = filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
      
      // Check if file exists
      if (!fs.existsSync(expandedPath)) {
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: false,
          error: `File not found: ${expandedPath}`
        }, null, 2) }], isError: true };
      }
      
      // Read file and convert to base64
      const fileContent = fs.readFileSync(expandedPath);
      const base64Data = fileContent.toString("base64");
      
      // Get filename from path
      const filename = path.basename(expandedPath);
      
      // Detect MIME type
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".txt": "text/plain", ".csv": "text/csv", ".zip": "application/zip",
      };
      const mimeType = mimeTypes[ext] || "application/octet-stream";
      
      // Send email
      const r = await sendEmail(auth, {
        to, subject, body, cc, bcc,
        attachments: [{ filename, mimeType, data: base64Data }],
      });
      
      return { content: [{ type: "text", text: JSON.stringify({ 
        success: true, 
        message: `✅ Email successfully sent to ${to}`,
        attachment: filename,
        size: `${(fileContent.length / 1024).toFixed(2)} KB`,
        sentAt: new Date().toISOString(),
        ...r 
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ 
        success: false,
        error: error.message
      }, null, 2) }], isError: true };
    }
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

  server.tool("send_email_with_url_attachment", "Send an email with a file from a URL attached (image, PDF, doc). Server downloads it directly.", {
    to: z.string(), subject: z.string(), body: z.string(),
    attachmentUrl: z.string().describe("Public URL of the file to attach"),
    filename: z.string().optional(),
    cc: z.string().optional(), bcc: z.string().optional(),
  }, async ({ to, subject, body, attachmentUrl, filename, cc, bcc }) => {
    const attachment = await fetchAttachmentFromUrl(attachmentUrl, filename);
    const r = await sendEmail(auth, { to, subject, body, cc, bcc, attachments: [attachment] });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...r, attached: attachment.filename }, null, 2) }] };
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
