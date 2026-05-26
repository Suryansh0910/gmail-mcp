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

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");

// Load .env from project root if present
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [key, ...val] = line.split("=");
    if (key && val.length) process.env[key.trim()] = val.join("=").trim();
  });
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║  .env file not found or missing credentials!                 ║
║                                                              ║
║  Create a .env file in the project root:                     ║
║    GMAIL_CLIENT_ID=your_client_id                            ║
║    GMAIL_CLIENT_SECRET=your_client_secret                    ║
║                                                              ║
║  Get these from whoever shared this repo with you.           ║
╚══════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
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
