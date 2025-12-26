const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const multer = require("multer");
const qrcode = require("qrcode-terminal");
const SESSION_PATH = './sessions';
const path = require("path");
const {makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
require("dotenv").config();
const { clerkMiddleware, requireAuth } = require("@clerk/express");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

let connectionStatus = "loading";
let lastQR = null;
let sock;

app.use(clerkMiddleware());

app.use(express.static("public"));
app.use(express.json());

// Clerk Sign-up.Sign-in
// Public route (no login required)
app.get("/", (req, res) => {
  res.send("Welcome to WhatsValid 🚀(public route)");
});

// Protected route (login required)
app.get("/dashboard", requireAuth(), (req, res) => {
  res.send(`Hello ${req.auth.userId}, welcome to your dashboard!`);
});

// Start WhatsApp socket
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      connectionStatus = 'disconnected'; // ✅ when QR shown, it's not connected
      console.log('\n📱 Scan this QR:\n');
      qrcode.generate(qr, { small: true });
    }
  
    if (connection === 'open') {
      connectionStatus = 'connected'; // ✅ connected
      lastQR = null;
      console.log('✅ WhatsApp connected!');
    } else if (connection === 'close') {
      connectionStatus = 'disconnected'; // ✅ disconnected
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Disconnected. Reason:', lastDisconnect?.error?.message);
  
      if (statusCode === 401) {
        console.log('⚠️ Session invalid. Deleting sessions...');
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      }
  
      const shouldReconnect = statusCode !== 401;
      if (shouldReconnect) {
        console.log('🔁 Reconnecting...');
        start(); // 👈 Restart connection
      } else {
        console.log('⛔ Cannot reconnect. Login required again.');
      }
    }
  });
  
  

  sock.ev.on("creds.update", saveCreds);
}

start();


// 🔧 Routes
app.get("/status", (req, res) => {
  res.json({ connectionStatus });
});

app.get("/qr", (req, res) => {
  if (lastQR) {
    res.json({ qr: lastQR });
  } else {
    res.status(204).send();
  }
});

app.post("/check", requireAuth(), async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).send({ error: "Number is required" });

  try {
    const result = await sock.onWhatsApp(`${number}@s.whatsapp.net`);
    res.json({ number, exists: result?.[0]?.exists || false });
  } catch (err) {
    console.error("❌ Error checking number:", err);
    res.status(500).json({ error: "Failed to check number" });
  }
});
app.post("/upload", requireAuth(), upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send({ error: "No file uploaded" });

  let numbers = [];

  if (file.mimetype === "text/plain") {
    const content = fs.readFileSync(file.path, "utf-8");
    numbers = content
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  } else if (file.mimetype === "text/csv") {
    const rows = [];
    fs.createReadStream(file.path)
      .pipe(csv())
      .on("data", (data) => rows.push(data))
      .on("end", async () => {
        numbers = rows.map((r) => Object.values(r)[0].trim());
        const results = await checkMany(numbers);
        fs.unlinkSync(file.path);
        res.json({ results });
      });
    return;
  } else {
    return res.status(400).send({ error: "Unsupported file type" });
  }

  const results = await checkMany(numbers);
  fs.unlinkSync(file.path);
  res.json({ results });
});

async function checkMany(numbers) {
  const results = [];
  for (const number of numbers) {
    try {
      const result = await sock.onWhatsApp(`${number}@s.whatsapp.net`);
      results.push({ number, exists: result?.[0]?.exists || false });
    } catch {
      results.push({ number, exists: null, error: "Error checking" });
    }
  }
  return results;
}

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
