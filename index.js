const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
 
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
 
// ── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
 
// ── Google OAuth2 ─────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://whatsappassistent-production.up.railway.app/auth/callback"
);
 
// Load saved tokens if present
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
}
 
const calendar = google.calendar({ version: "v3", auth: oauth2Client });
const gmail = google.gmail({ version: "v1", auth: oauth2Client });
 
// ── Google Auth Routes ────────────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    prompt: "consent",
  });
  res.redirect(url);
});
 
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  console.log("✅ GOOGLE_REFRESH_TOKEN:", tokens.refresh_token);
  res.send(
    `<h2>✅ Google connected!</h2><p>Copy this refresh token into your Railway environment variables as <strong>GOOGLE_REFRESH_TOKEN</strong>:</p><pre>${tokens.refresh_token}</pre>`
  );
});
 
// ── Helper: get calendar events ───────────────────────────────────────────────
async function getCalendarEvents(days = 1) {
  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);
 
  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });
 
  const events = response.data.items;
  if (!events || events.length === 0) return "No upcoming events found.";
 
  return events
    .map((e) => {
      const start = e.start.dateTime || e.start.date;
      return `• ${e.summary} at ${start}`;
    })
    .join("\n");
}
 
// ── Helper: get recent emails ─────────────────────────────────────────────────
async function getRecentEmails(maxResults = 5) {
  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX", "UNREAD"],
  });
 
  const messages = response.data.messages;
  if (!messages || messages.length === 0) return "No unread emails.";
 
  const details = await Promise.all(
    messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });
      const headers = msg.data.payload.headers;
      const subject =
        headers.find((h) => h.name === "Subject")?.value || "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value || "unknown";
      return `• From: ${from}\n  Subject: ${subject}`;
    })
  );
 
  return details.join("\n\n");
}
 
// ── Helper: send WhatsApp reply ───────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to,
    body,
  });
}
 
// ── Main webhook ──────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge Twilio immediately
 
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;
 
  if (!incomingMsg || !from) return;
 
  try {
    // Gather context from Google
    let calendarContext = "";
    let emailContext = "";
 
    try {
      calendarContext = await getCalendarEvents(3);
    } catch (e) {
      calendarContext = "Could not fetch calendar events.";
    }
 
    try {
        emailContext = await getRecentEmails(5);
    } catch (e) {
      console.error("EMAIL ERROR:", e.message, e.code, JSON.stringify(e.errors));
      emailContext = "Could not fetch emails.";
    }
 
    // Ask Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `You are a helpful personal assistant. You have access to the user's Google Calendar and Gmail.
      
Current calendar (next 3 days):
${calendarContext}
 
Recent unread emails:
${emailContext}
 
Answer the user's question based on this information. Be concise and friendly. 
If they ask to create an event or reply to an email, let them know that feature is coming soon.`,
      messages: [{ role: "user", content: incomingMsg }],
    });
 
    const reply = response.content[0].text;
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error("Error:", err);
    await sendWhatsApp(from, "Sorry, something went wrong. Please try again.");
  }
});
 
// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
