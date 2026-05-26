#!/usr/bin/env node
/**
 * Gmail MCP Server
 * Exposes Gmail as Claude tools via the Model Context Protocol.
 *
 * Usage:
 *   node src/index.js          (stdio transport — for claude.ai / Claude Code)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildAuth,
  listMessages,
  getMessage,
  getAttachment,
  sendEmail,
  listLabels,
  modifyLabels,
  trashMessage,
  getProfile,
  listThreads,
} from "./gmail.js";

// ─── Init ─────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "gmail-mcp",
  version: "1.0.0",
});

let auth;
try {
  auth = buildAuth();
} catch (e) {
  process.stderr.write(`[gmail-mcp] Auth error: ${e.message}\n`);
  process.stderr.write(`[gmail-mcp] Run: node src/auth.js\n`);
  process.exit(1);
}

// ─── Tool: get_profile ────────────────────────────────────────────────────────

server.tool(
  "get_profile",
  "Get your Gmail account profile — email address, total messages, total threads.",
  {},
  async () => {
    const profile = await getProfile(auth);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(profile, null, 2),
      }],
    };
  }
);

// ─── Tool: list_emails ───────────────────────────────────────────────────────

server.tool(
  "list_emails",
  `Fetch emails from your Gmail inbox. Supports Gmail search syntax in the query field.
Examples of query values:
  "is:unread"                  → unread emails
  "from:boss@company.com"      → from a specific sender
  "has:attachment"             → emails with attachments
  "subject:invoice"            → emails with "invoice" in subject
  "after:2024/01/01 is:unread" → unread after a date
  "label:work"                 → emails with a label
  ""                           → recent inbox emails`,
  {
    query: z.string().optional().default("").describe("Gmail search query. Empty = recent inbox."),
    maxResults: z.number().int().min(1).max(50).optional().default(10).describe("Number of emails to return (1–50)"),
    labelIds: z.array(z.string()).optional().default([]).describe("Filter by label IDs e.g. ['INBOX','UNREAD']"),
  },
  async ({ query, maxResults, labelIds }) => {
    const msgs = await listMessages(auth, { query, maxResults, labelIds });
    const summary = msgs.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      snippet: m.snippet,
      hasAttachments: m.hasAttachments,
      attachments: m.attachments.map((a) => ({ filename: a.filename, size: a.size, attachmentId: a.attachmentId })),
      labelIds: m.labelIds,
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify(summary, null, 2),
      }],
    };
  }
);

// ─── Tool: read_email ────────────────────────────────────────────────────────

server.tool(
  "read_email",
  "Read the full content of a specific email by its message ID. Returns headers, full body, and attachment metadata.",
  {
    messageId: z.string().describe("Gmail message ID (from list_emails)"),
  },
  async ({ messageId }) => {
    const msg = await getMessage(auth, messageId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(msg, null, 2),
      }],
    };
  }
);

// ─── Tool: download_attachment ───────────────────────────────────────────────

server.tool(
  "download_attachment",
  "Download a specific email attachment. Returns base64-encoded file data.",
  {
    messageId: z.string().describe("Gmail message ID"),
    attachmentId: z.string().describe("Attachment ID from the email's attachments list"),
    filename: z.string().describe("Original filename (for reference)"),
  },
  async ({ messageId, attachmentId, filename }) => {
    const att = await getAttachment(auth, messageId, attachmentId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          filename,
          size: att.size,
          mimeType: "application/octet-stream",
          data: att.data,
          note: "data is base64url-encoded. Decode it to get the file bytes.",
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: send_email ────────────────────────────────────────────────────────

server.tool(
  "send_email",
  "Send an email from your Gmail account. Supports plain text body, CC, BCC, and reply-to-thread.",
  {
    to: z.string().describe("Recipient email(s). Multiple: 'a@x.com, b@x.com'"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain text email body"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
    bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
    replyToMessageId: z.string().optional().describe("Message ID to reply to (keeps thread)"),
  },
  async ({ to, subject, body, cc, bcc, replyToMessageId }) => {
    const result = await sendEmail(auth, { to, subject, body, cc, bcc, replyToMessageId });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, ...result }, null, 2),
      }],
    };
  }
);

// ─── Tool: list_labels ───────────────────────────────────────────────────────

server.tool(
  "list_labels",
  "List all Gmail labels (system labels like INBOX, SENT, SPAM and custom labels you created).",
  {},
  async () => {
    const labels = await listLabels(auth);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(labels, null, 2),
      }],
    };
  }
);

// ─── Tool: label_email ───────────────────────────────────────────────────────

server.tool(
  "label_email",
  "Add or remove labels on an email. Use to mark as read/unread, star, archive, or apply custom labels.",
  {
    messageId: z.string().describe("Gmail message ID"),
    addLabels: z.array(z.string()).optional().default([]).describe("Label IDs to add. e.g. ['STARRED'] or ['UNREAD']"),
    removeLabels: z.array(z.string()).optional().default([]).describe("Label IDs to remove. e.g. ['UNREAD'] to mark as read"),
  },
  async ({ messageId, addLabels, removeLabels }) => {
    const result = await modifyLabels(auth, messageId, { addLabels, removeLabels });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ─── Tool: trash_email ───────────────────────────────────────────────────────

server.tool(
  "trash_email",
  "Move an email to Gmail trash. It can be recovered from Trash within 30 days.",
  {
    messageId: z.string().describe("Gmail message ID to trash"),
  },
  async ({ messageId }) => {
    const result = await trashMessage(auth, messageId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ─── Tool: list_threads ──────────────────────────────────────────────────────

server.tool(
  "list_threads",
  "List email threads (conversations). Each thread groups related messages together.",
  {
    query: z.string().optional().default("").describe("Gmail search query to filter threads"),
    maxResults: z.number().int().min(1).max(50).optional().default(10).describe("Number of threads (1–50)"),
  },
  async ({ query, maxResults }) => {
    const threads = await listThreads(auth, { query, maxResults });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(threads, null, 2),
      }],
    };
  }
);

// ─── Tool: search_emails ─────────────────────────────────────────────────────

server.tool(
  "search_emails",
  `Search emails using full Gmail search syntax. Returns matching emails with full details.
Common patterns:
  Unread from someone:  "from:name@domain.com is:unread"
  Attachments only:     "has:attachment filename:pdf"
  Date range:           "after:2024/06/01 before:2024/07/01"
  Subject keyword:      "subject:(meeting OR invoice)"
  Exclude spam:         "in:inbox -in:spam keyword"`,
  {
    query: z.string().describe("Full Gmail search query string"),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ query, maxResults }) => {
    const msgs = await listMessages(auth, { query, maxResults });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(msgs, null, 2),
      }],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[gmail-mcp] Server running on stdio\n");
