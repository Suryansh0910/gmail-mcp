# gmail-mcp

A Gmail MCP (Model Context Protocol) server — plug your Gmail directly into Claude.

Two modes depending on your use case:

| Mode | File | Best for |
|------|------|----------|
| **Local** (`src/index.js`) | stdio | Claude Desktop / Claude Code on your Mac — full filesystem access, send local files as attachments |
| **Online** (`src/http.js`) | HTTP + OAuth | Hosted server, multi-user, browser Claude — text emails only, no local file access |

---

## Local Mode

### Tools

| Tool | What it does |
|------|-------------|
| `get_profile` | Your Gmail address and message count |
| `list_emails` | Fetch inbox with Gmail search syntax |
| `read_email` | Full email body + attachments list |
| `send_email` | Send email with CC/BCC, reply in thread |
| `send_email_with_local_file` | Attach a file from your Mac (e.g. `~/Downloads/resume.pdf`) |
| `send_email_with_url_attachment` | Attach a file downloaded from a URL |
| `download_attachment` | Get attachment as base64 |
| `save_attachment_to_local_disk` | Save an email attachment directly to `~/Downloads/` |
| `list_labels` | All labels (INBOX, SENT, custom…) |
| `label_email` | Mark read/unread, star, archive |
| `trash_email` | Move to trash |
| `list_threads` | Conversation threads |
| `search_emails` | Full Gmail search syntax |

### Setup

#### 1. Google Cloud credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use existing)
3. **APIs & Services → Enable APIs** → search "Gmail API" → Enable
4. **APIs & Services → OAuth consent screen**
   - App type: **External**
   - Fill app name and your email
   - Add scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`
   - Add your Gmail as a **Test user**
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON → save as `credentials.json` in this folder

#### 2. Install dependencies

```bash
npm install
```

#### 3. Authorize your Gmail account

```bash
node src/auth.js
```

Opens a browser → log in with Google → approves OAuth scopes → saves `token.json`.

#### 4. Connect to Claude

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

**Claude Code** — run once:

```bash
claude mcp add gmail node /absolute/path/to/gmail-mcp/src/index.js
```

---

## Online Mode

### Tools

Same as local mode **except** — no `send_email_with_local_file` and no `save_attachment_to_local_disk`. Everything else is the same.

### Setup

#### 1. Google Cloud credentials (Web app)

Same steps as above, but at step 5 choose **Application type: Web application** and set the redirect URI to `https://your-domain.com/callback`.

#### 2. Environment variables

Create a `.env` file:

```
WEB_CLIENT_ID=your-web-oauth-client-id
WEB_CLIENT_SECRET=your-web-oauth-client-secret
BASE_URL=https://your-domain.com
PORT=3000
```

#### 3. Run the server

```bash
node src/http.js
```

#### 4. Connect to Claude

Add `https://your-domain.com/mcp` as an MCP server in Claude. It will prompt users to log in with Google automatically.

---

## Usage examples

Once connected, just talk naturally:

```
Show me my last 10 unread emails
Any emails with attachments from this week?
Send an email to john@example.com saying "Meeting at 3pm"
Send ~/Downloads/Resume.pdf to hr@company.com
Save the PDF attachment from that invoice email to my Downloads
Search for emails from my boss about the Q3 report
Mark that email as read
Reply to the last email from sarah@company.com
```

---

## Gmail search syntax

| Query | Meaning |
|-------|---------|
| `is:unread` | Unread emails |
| `is:starred` | Starred emails |
| `from:someone@gmail.com` | From a specific sender |
| `has:attachment` | Has attachments |
| `filename:pdf` | Has a PDF attachment |
| `subject:invoice` | Subject contains word |
| `after:2024/01/01` | After a date |
| `label:work` | Has a custom label |
| `in:sent` | In Sent folder |
| `larger:5M` | Larger than 5MB |

Combine: `from:boss@co.com is:unread has:attachment after:2024/01/01`

---

## File structure

```
gmail-mcp/
├── src/
│   ├── index.js       ← Local stdio MCP server (full filesystem access)
│   ├── http.js        ← Online HTTP MCP server (multi-user OAuth, no file access)
│   ├── gmail.js       ← Gmail API wrapper
│   └── auth.js        ← OAuth setup for local mode (run once)
├── credentials.json   ← From Google Cloud (you add this)
├── token.json         ← Auto-created after running auth.js
├── .env               ← For online mode (WEB_CLIENT_ID, etc.)
├── package.json
└── README.md
```

---

## Troubleshooting

**"credentials.json missing"** → Download OAuth credentials from Google Cloud Console.

**"token.json missing"** → Run `node src/auth.js` and complete the browser auth flow.

**"Access blocked"** → In the OAuth consent screen, add your Gmail under "Test users".

**Token expired** → Tokens auto-refresh. If it fails, delete `token.json` and re-run `node src/auth.js`.

**Attachment corrupted** → Make sure you're using local mode (`src/index.js`) when sending files from your Mac. The online mode does not have filesystem access.
