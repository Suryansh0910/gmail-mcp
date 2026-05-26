#!/usr/bin/env node
/**
 * gmail-mcp auth
 * Run once: node src/auth.js
 * Opens browser → Google OAuth → saves token.json
 */

import { google } from "googleapis";
import express from "express";
import open from "open";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");
const CREDS_PATH = path.join(CONFIG_DIR, "credentials.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║  credentials.json not found!                                 ║
║                                                              ║
║  Steps:                                                      ║
║  1. Go to https://console.cloud.google.com                   ║
║  2. Create a project → Enable Gmail API                      ║
║  3. OAuth consent screen → External → add yourself as tester ║
║  4. Credentials → OAuth client ID → Desktop app → Download   ║
║  5. Save the file as:                                        ║
║     ~/.gmail-mcp/credentials.json                            ║
╚══════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3141/oauth2callback"
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n🔐 Gmail MCP — OAuth Setup\n");
  console.log("Opening browser for Google login...");
  console.log("If browser doesn't open, visit:\n", authUrl, "\n");

  const app = express();
  const server = app.listen(3141, () => {
    open(authUrl).catch(() => {});
  });

  await new Promise((resolve, reject) => {
    app.get("/oauth2callback", async (req, res) => {
      const code = req.query.code;
      if (!code) {
        res.send("Error: no code received.");
        reject(new Error("No auth code"));
        return;
      }
      try {
        const { tokens } = await oauth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        res.send(`
          <html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2>✅ Gmail MCP authorized!</h2>
            <p>You can close this tab and return to your terminal.</p>
          </body></html>
        `);
        console.log("\n✅ Token saved to token.json");
        console.log("You can now run the MCP server:\n  node src/index.js\n");
        resolve();
      } catch (e) {
        res.send("Auth failed: " + e.message);
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

main().catch(console.error);
