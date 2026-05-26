import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");
const CREDS_PATH = path.join(CONFIG_DIR, "credentials.json");

export function buildAuth() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("credentials.json missing — run: node src/auth.js");
  if (!fs.existsSync(TOKEN_PATH)) throw new Error("token.json missing — run: node src/auth.js");

  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_id, client_secret } = creds.installed || creds.web;
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3141/oauth2callback");
  oauth2Client.setCredentials(token);

  // Auto-refresh and persist new token
  oauth2Client.on("tokens", (t) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...t }, null, 2));
  });

  return oauth2Client;
}

export function gmail(auth) {
  return google.gmail({ version: "v1", auth });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function getHeader(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractParts(payload, body = { text: "", html: "" }, attachments = []) {
  if (!payload) return { body, attachments };

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    body.text += decodeBase64(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    body.html += decodeBase64(payload.body.data);
  } else if (payload.filename && payload.body) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
      partId: payload.partId,
    });
  }

  for (const part of payload.parts ?? []) extractParts(part, body, attachments);
  return { body, attachments };
}

function formatMessage(msg) {
  const h = msg.payload?.headers ?? [];
  const { body, attachments } = extractParts(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet,
    from: getHeader(h, "from"),
    to: getHeader(h, "to"),
    cc: getHeader(h, "cc"),
    subject: getHeader(h, "subject"),
    date: getHeader(h, "date"),
    body: body.text || body.html || "(no body)",
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

// ─── Gmail API Functions ──────────────────────────────────────────────────────

export async function listMessages(auth, { query = "", maxResults = 10, labelIds = [] } = {}) {
  const g = gmail(auth);
  const params = { userId: "me", maxResults, q: query };
  if (labelIds.length) params.labelIds = labelIds;

  const listRes = await g.users.messages.list(params);
  const messages = listRes.data.messages ?? [];

  const full = await Promise.all(
    messages.map((m) => g.users.messages.get({ userId: "me", id: m.id, format: "full" }))
  );

  return full.map((r) => formatMessage(r.data));
}

export async function getMessage(auth, messageId) {
  const g = gmail(auth);
  const res = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return formatMessage(res.data);
}

export async function getAttachment(auth, messageId, attachmentId) {
  const g = gmail(auth);
  const res = await g.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  return {
    data: res.data.data,
    size: res.data.size,
  };
}

export async function sendEmail(auth, { to, cc, bcc, subject, body, replyToMessageId, attachments = [] }) {
  const g = gmail(auth);

  // Build MIME message
  const boundary = "gmail_mcp_" + Date.now();
  const hasAttachments = attachments.length > 0;

  let headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
  ].filter(Boolean);

  let mime;
  if (!hasAttachments) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    mime = headers.join("\r\n") + "\r\n\r\n" + body;
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ];
    for (const att of attachments) {
      parts.push(`--${boundary}`);
      parts.push(`Content-Type: ${att.mimeType}`);
      parts.push(`Content-Transfer-Encoding: base64`);
      parts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      parts.push("");
      parts.push(att.data);
    }
    parts.push(`--${boundary}--`);
    mime = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
  }

  const encoded = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const params = { userId: "me", requestBody: { raw: encoded } };
  if (replyToMessageId) {
    const orig = await getMessage(auth, replyToMessageId);
    params.requestBody.threadId = orig.threadId;
  }

  const res = await g.users.messages.send(params);
  return { id: res.data.id, threadId: res.data.threadId, status: "sent" };
}

export async function listLabels(auth) {
  const g = gmail(auth);
  const res = await g.users.labels.list({ userId: "me" });
  return res.data.labels ?? [];
}

export async function modifyLabels(auth, messageId, { addLabels = [], removeLabels = [] }) {
  const g = gmail(auth);
  await g.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: addLabels, removeLabelIds: removeLabels },
  });
  return { success: true, messageId };
}

export async function trashMessage(auth, messageId) {
  const g = gmail(auth);
  await g.users.messages.trash({ userId: "me", id: messageId });
  return { success: true, messageId, status: "trashed" };
}

export async function getProfile(auth) {
  const g = gmail(auth);
  const res = await g.users.getProfile({ userId: "me" });
  return res.data;
}

export async function listThreads(auth, { query = "", maxResults = 10 } = {}) {
  const g = gmail(auth);
  const listRes = await g.users.threads.list({ userId: "me", maxResults, q: query });
  const threads = listRes.data.threads ?? [];

  const full = await Promise.all(
    threads.map((t) => g.users.threads.get({ userId: "me", id: t.id, format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"] }))
  );

  return full.map((r) => {
    const msgs = r.data.messages ?? [];
    const last = msgs[msgs.length - 1];
    const h = last?.payload?.headers ?? [];
    return {
      threadId: r.data.id,
      messageCount: msgs.length,
      subject: getHeader(h, "subject"),
      from: getHeader(h, "from"),
      date: getHeader(h, "date"),
      snippet: r.data.snippet,
    };
  });
}
