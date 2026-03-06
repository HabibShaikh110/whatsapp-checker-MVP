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
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 5500;
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

let connectionStatus = "loading";
let lastQR = null;
let sock;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

app.use(express.static("public"));
app.use(express.json());

// Validate phone number: only digits, optionally starting with +
function isValidPhoneNumber(number) {
  return /^\+?\d{7,15}$/.test(number);
}

function getReconnectDelay() {
  // Exponential backoff: 2s, 4s, 8s, 16s, 32s
  return Math.min(2000 * Math.pow(2, reconnectAttempts), 32000);
}

// Start WhatsApp socket
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      connectionStatus = 'disconnected';
      console.log('\n📱 Scan this QR:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      lastQR = null;
      reconnectAttempts = 0; // Reset on successful connection
      console.log('✅ WhatsApp connected!');
    } else if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Unknown';
      console.log(`❌ Disconnected. Code: ${statusCode}, Reason: ${reason}`);

      // Handle session invalid (logged out)
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('⚠️ Session invalid. Deleting sessions...');
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        console.log('⛔ Cannot reconnect. Login required again. Restart the server.');
        return;
      }

      // Handle conflict (another device replaced this session)
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log('⚠️ Connection replaced by another session. Not reconnecting to avoid loop.');
        console.log('⛔ Restart the server manually if needed.');
        return;
      }

      // For other errors, reconnect with backoff
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`⛔ Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Restart the server.`);
        return;
      }

      reconnectAttempts++;
      const delay = getReconnectDelay();
      console.log(`🔁 Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

      setTimeout(() => {
        start();
      }, delay);
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

app.post("/check", async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: "WhatsApp is not connected yet" });
  }

  const { number } = req.body;
  if (!number) return res.status(400).json({ error: "Number is required" });

  const cleaned = String(number).replace(/[\s\-()]/g, "");
  if (!isValidPhoneNumber(cleaned)) {
    return res.status(400).json({ error: "Invalid phone number format" });
  }

  try {
    const result = await sock.onWhatsApp(`${cleaned}@s.whatsapp.net`);
    res.json({ number: cleaned, exists: result?.[0]?.exists || false });
  } catch (err) {
    console.error("❌ Error checking number:", err);
    res.status(500).json({ error: "Failed to check number" });
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: "WhatsApp is not connected yet" });
  }

  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const cleanupFile = () => {
    try { fs.unlinkSync(file.path); } catch {}
  };

  let numbers = [];

  try {
    if (file.mimetype === "text/plain") {
      const content = fs.readFileSync(file.path, "utf-8");
      numbers = content
        .split("\n")
        .map((n) => n.trim())
        .filter(Boolean);
    } else if (file.mimetype === "text/csv") {
      const rows = [];
      await new Promise((resolve, reject) => {
        fs.createReadStream(file.path)
          .pipe(csv())
          .on("data", (data) => rows.push(data))
          .on("end", resolve)
          .on("error", reject);
      });
      numbers = rows.map((r) => Object.values(r)[0]?.trim()).filter(Boolean);
    } else {
      cleanupFile();
      return res.status(400).json({ error: "Unsupported file type. Use .txt or .csv" });
    }

    const results = await checkMany(numbers);
    cleanupFile();
    res.json({ results });
  } catch (err) {
    console.error("❌ Error processing upload:", err);
    cleanupFile();
    res.status(500).json({ error: "Failed to process file" });
  }
});

async function checkMany(numbers) {
  const results = [];
  for (const raw of numbers) {
    const number = String(raw).replace(/[\s\-()]/g, "");
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
