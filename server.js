const express = require("express");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const bodyParser = require("body-parser");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
const PORT = process.env.PORT || 8080;

// ENV VARS
const SECRET_TOKEN = process.env.SECRET_TOKEN || "gigs2025tokenX107";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!OPENAI_API_KEY || !EMAIL_USER || !EMAIL_PASS) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Gigs in memory
const gigsPath = path.join(__dirname, "_data", "gigs.json");

let gigsCache = [];
let isFileWritable = true;

// Load gigs from file
try {
  const content = fs.readFileSync(gigsPath, "utf-8");
  gigsCache = JSON.parse(content);
} catch {
  console.warn("📁 No gigs.json found. Starting empty.");
  gigsCache = [];
}

// Check if file is writable
try {
  fs.accessSync(gigsPath, fs.constants.W_OK);
} catch {
  console.warn("⚠️ gigs.json not writable — in-memory only");
  isFileWritable = false;
}

// Serve static files.
app.use(bodyParser.json());
app.use(express.static("dist"));

// Route to serve gigs
app.get("/gigs.json", (req, res) => {
  res.json(gigsCache);
});

// Route to add gigs via AI
app.post("/api/parse-and-add", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET_TOKEN}`) {
    return res.status(403).json({ error: "Forbidden: Invalid token" });
  }

  const message = req.body.message;
  if (!message) return res.status(400).json({ error: "Missing message" });

  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a strict date parser. Extract gig info and return ONLY valid JSON. The 'date' field MUST be in ISO format: YYYY-MM-DD. Do not include month names or slashes. Example: '2025-04-25'. Keys: date, venue, city, time (like '8:00 PM').",
        },
        { role: "user", content: message },
      ],
    });

    let parsed;

    try {
      parsed = JSON.parse(aiResponse.choices[0].message.content.trim());
    } catch (err) {
      console.warn(
        "❌ Invalid JSON returned by AI:",
        aiResponse.choices[0].message.content
      );
      return res.status(500).json({ error: "Invalid JSON from AI" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      console.warn("⛔ Invalid date format:", parsed.date);
      return res.status(400).json({ error: "Invalid date format" });
    }

    gigsCache.push(parsed);

    if (isFileWritable) {
      fs.writeFileSync(gigsPath, JSON.stringify(gigsCache, null, 2));
    }

    res.json({ gig: parsed });
  } catch (err) {
    console.error("❌ AI parse error:", err);
    res.status(500).json({ error: "Failed to0 parse message" });
  }
});

// Email polling function

// Run this every 10 min to pull new gig emails
// Run this every 10 min to pull new gig emails
function checkMail() {
  console.log("📬 Checking for new gigs via email...");

  const imap = new Imap({
    user: EMAIL_USER, // your full @icloud.com or @me.com email
    password: EMAIL_PASS, // an app-specific password!
    host: "imap.mail.me.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }, // still required in some Node envs like Railway
  });

  function openInbox(cb) {
    imap.openBox("NearlyForgot", false, cb);
  }

  imap.once("ready", function () {
    openInbox(function (err, box) {
      if (err) {
        console.error("❌ Inbox error:", err);
        imap.end();
        return;
      }

      imap.search(["UNSEEN", ["SUBJECT", "gig"]], function (err, results) {
        console.log("📨 Search results:", results);
        if (err || !results.length) {
          console.log("📭 No new messages.");
          imap.end();
          return;
        }

        const f = imap.fetch(results, { bodies: "" });

        f.on("message", function (msg) {
          msg.on("body", function (stream) {
            simpleParser(stream, async (err, parsed) => {
              if (err) {
                console.error("❌ Email parse error:", err);
                return;
              }

              const emailText = parsed.text.trim();
              console.log("📩 Email body:", emailText);

              try {
                const fetch = (await import("node-fetch")).default;
                const res = await fetch(`${BASE_URL}/api/parse-and-add`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SECRET_TOKEN}`,
                  },
                  body: JSON.stringify({ message: emailText }),
                });

                const result = await res.json();
                console.log("✅ Gig added from email:", result);
              } catch (err) {
                console.error("❌ API post failed:", err.message);
              }
            });
          });

          msg.once("attributes", function (attrs) {
            imap.addFlags(attrs.uid, ["\\Seen"], () => {
              console.log("📌 Marked email as read");
            });
          });
        });

        f.once("error", function (err) {
          console.error("❌ Fetch error:", err);
        });

        f.once("end", function () {
          console.log("✅ Done processing email.");
          imap.end();
        });
      });
    });
  });

  imap.once("error", function (err) {
    console.error("❌ IMAP error:", err);
  });

  imap.once("end", function () {
    console.log("👋 Email check complete");
  });

  imap.connect();
}

// function checkMail() {
//   console.log("📬 Checking for new gigs via email...");

//   const imap = new Imap({
//     user: EMAIL_USER,
//     password: EMAIL_PASS,
//     host: "imap.gmail.com",
//     port: 993,
//     tls: true,
//   });

//   function openInbox(cb) {
//     imap.openBox("INBOX", false, cb);
//   }

//   imap.once("ready", function () {
//     openInbox(function (err, box) {
//       if (err) {
//         console.error("❌ Inbox error:", err);
//         imap.end();
//         return;
//       }

//       imap.search(["UNSEEN"], function (err, results) {
//         if (err || !results.length) {
//           console.log("📭 No new messages.");
//           imap.end();
//           return;
//         }

//         const f = imap.fetch(results, { bodies: "" });

//         f.on("message", function (msg) {
//           msg.on("body", function (stream) {
//             simpleParser(stream, async (err, parsed) => {
//               if (err) {
//                 console.error("❌ Parse error:", err);
//                 return;
//               }

//               const emailText = parsed.text.trim();
//               console.log("📩 Email body:", emailText);

//               // Send to local API
//               try {
//                 const res = await fetch(
//                   `http://localhost:${PORT}/api/parse-and-add`,
//                   {
//                     method: "POST",
//                     headers: {
//                       "Content-Type": "application/json",
//                       Authorization: `Bearer ${SECRET_TOKEN}`,
//                     },
//                     body: JSON.stringify({ message: emailText }),
//                   }
//                 );

//                 const result = await res.json();
//                 console.log("✅ Gig added from email:", result);
//               } catch (err) {
//                 console.error("❌ API post failed:", err.message);
//               }
//             });
//           });

//           msg.once("attributes", function (attrs) {
//             imap.addFlags(attrs.uid, ["\\Seen"], () => {
//               console.log("📌 Marked email as read");
//             });
//           });
//         });

//         f.once("error", function (err) {
//           console.error("Fetch error:", err);
//         });

//         f.once("end", function () {
//           console.log("✅ Done processing new mail.");
//           imap.end();
//         });
//       });
//     });
//   });

//   imap.once("error", function (err) {
//     console.error("IMAP error:", err);
//   });

//   imap.once("end", function () {
//     console.log("👋 Email check complete");
//   });

//   imap.connect();
// }

// Start the app
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);

  // Check email every 10 minutes
  setInterval(checkMail, 10 * 60 * 1000);

  // Optional: Run immediately on startup
  checkMail();
});

process.on("uncaughtException", (err) => {
  console.error("🧨 Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🧨 Unhandled Rejection:", err);
});
