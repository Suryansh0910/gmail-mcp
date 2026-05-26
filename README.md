# gmail-mcp

A Gmail MCP (Model Context Protocol) server — plug your Gmail directly into Claude Code, Claude Desktop, or any MCP-compatible Claude client.

## What you get

| Tool | What it does |
|------|-------------|
| `get_profile` | Your Gmail address, message count |
| `list_emails` | Fetch inbox with Gmail search syntax |
| `read_email` | Full email body + attachments list |
| `download_attachment` | Download any attachment (base64) |
| `send_email` | Send email, CC/BCC, reply in thread |
| `list_labels` | All labels (INBOX, SENT, custom…) |
| `label_email` | Mark read/unread, star, archive |
| `trash_email` | Move to trash |
| `list_threads` | Conversation threads |
| `search_emails` | Full Gmail search syntax |

---

## Setup

### 1. Google Cloud credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use existing)
3. **APIs & Services → Enable APIs** → search "Gmail API" → Enable
4. **APIs & Services → OAuth consent screen**
   - App type: **External**
   - Fill app name, your email
   - Add scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`
   - Add your Gmail as a **Test user**
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Download JSON → save as `credentials.json` in this folder

### 2. Install dependencies

```bash
npm install
```

### 3. Authorize your Gmail account

```bash
node src/auth.js
```

This opens your browser → log in with Google → approves the OAuth scopes → saves `token.json`.

---

## Connect to Claude

### Claude Code (recommended)

Add to your Claude Code MCP config (`~/.claude/mcp_config.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp/src/index.js"]
    }
  }
}
```

Or via CLI:
```bash
claude mcp add gmail node /absolute/path/to/gmail-mcp/src/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp/src/index.js"]
    }
  }
}
```

Restart Claude Desktop.

---

## Usage in Claude

Once connected, just talk naturally:

```
"Show me my last 10 unread emails"
"Any emails with attachments from this week?"
"Send an email to john@example.com with subject 'Hello' and body 'Meeting at 3pm'"
"Search for emails from my boss about the Q3 report"
"Mark that email as read"
"Download the PDF attachment from that invoice email"
"Reply to the last email from sarah@company.com"
"List all my Gmail labels"
```

---

## Gmail Search Syntax (for list_emails / search_emails)

| Query | Meaning |
|-------|---------|
| `is:unread` | Unread emails |
| `is:starred` | Starred emails |
| `from:someone@gmail.com` | From a sender |
| `to:me@gmail.com` | Sent to you |
| `has:attachment` | Has attachments |
| `filename:pdf` | PDF attachments |
| `subject:invoice` | Subject contains word |
| `after:2024/01/01` | After date |
| `before:2024/12/31` | Before date |
| `label:work` | Has custom label |
| `in:sent` | In Sent folder |
| `in:spam` | In Spam |
| `larger:5M` | Larger than 5MB |

Combine them: `from:boss@co.com is:unread has:attachment after:2024/01/01`

---

## File structure

```
gmail-mcp/
├── src/
│   ├── index.js       ← MCP server (all tools)
│   ├── gmail.js       ← Gmail API wrapper
│   └── auth.js        ← OAuth setup (run once)
├── credentials.json   ← From Google Cloud (you add this)
├── token.json         ← Auto-created after auth
├── package.json
└── README.md
```

---

## Troubleshooting

**"credentials.json missing"** → Download OAuth credentials from Google Cloud Console.

**"token.json missing"** → Run `node src/auth.js` and complete the browser auth flow.

**"Access blocked"** → In OAuth consent screen, add your Gmail under "Test users".

**Token expired** → Tokens auto-refresh. If it fails, delete `token.json` and re-run `node src/auth.js`.
