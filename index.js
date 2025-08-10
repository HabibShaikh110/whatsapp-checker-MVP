const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const multer = require("multer");
const qrcode = require("qrcode-terminal");
const SESSION_PATH = './sessions';

const {makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

let connectionStatus = "loading";
let lastQR = null;
let sock;
// In-memory daily & monthly usage tracking
const path = require("path");
const usageFile = './usage.json';

// Load usage data from file (or init if missing)
function loadUsage() {
  if (fs.existsSync(usageFile)) {
    return JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
  }
  return { lastDailyReset: new Date().toISOString().slice(0, 10), lastMonthlyReset: new Date().toISOString().slice(0, 10), users: {} };
}

// Save usage data to file
function saveUsage(data) {
  fs.writeFileSync(usageFile, JSON.stringify(data, null, 2));
}

// Reset checks if needed
function resetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  const usage = loadUsage();

  if (usage.lastDailyReset !== today) {
    for (const ip in usage.users) usage.users[ip].daily = 0;
    usage.lastDailyReset = today;
    console.log("✅ Daily check counts reset.");
  }

  const daysSinceMonthly = Math.floor((new Date(today) - new Date(usage.lastMonthlyReset)) / (1000 * 60 * 60 * 24));
  if (daysSinceMonthly >= 30) {
    for (const ip in usage.users) usage.users[ip].monthly = 0;
    usage.lastMonthlyReset = today;
    console.log("✅ Monthly check counts reset.");
  }

  saveUsage(usage);
}

// Helper to get IP usage
function getUserUsage(ip) {
  const usage = loadUsage();
  if (!usage.users[ip]) usage.users[ip] = { daily: 0, monthly: 0 };
  saveUsage(usage);
  return usage;
}

app.use(express.static("public"));
app.use(express.json());

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
        console.log('⚠️ Session invalid. Deleting sessions...')
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        fs.mkdirSync(SESSION_PATH);
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
function hasReachedLimit(ip) {
  resetIfNeeded();
  const usage = getUserUsage(ip);
  if (usage.users[ip].daily >= 10) return { limit: "daily" };
  if (usage.users[ip].monthly >= 100) return { limit: "monthly" };
  return null;
}

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
  const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = (ipRaw.split(',')[0] || '').replace(/^::ffff:/, '').trim();

  const { number } = req.body;
  if (!number) return res.status(400).send({ error: "Number is required" });

  const limitStatus = hasReachedLimit(ip);
  if (limitStatus) {
    return res.status(429).json({ error: `${limitStatus.limit} limit reached.` });
  }

  const results = await checkMany([number], ip);
  res.json(results[0]);
});


app.post("/upload", upload.single("file"), async (req, res) => {
  const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = (ipRaw.split(',')[0] || '').replace(/^::ffff:/, '').trim();

  const limitStatus = hasReachedLimit(ip);
  if (limitStatus) {
    return res.status(429).json({ error: `${limitStatus.limit} limit reached.` });
  }

  const file = req.file;
  if (!file) return res.status(400).send({ error: "No file uploaded" });

  let numbers = [];
  if (file.mimetype === "text/plain") {
    const content = fs.readFileSync(file.path, "utf-8");
    numbers = content.split("\n").map(n => n.trim()).filter(Boolean);
  } else if (file.mimetype === "text/csv") {
    const rows = [];
    fs.createReadStream(file.path)
      .pipe(csv())
      .on("data", (data) => rows.push(data))
      .on("end", async () => {
        numbers = rows.map((r) => Object.values(r)[0].trim());
        const results = await checkMany(numbers, ip);
        fs.unlinkSync(file.path);
        res.json({ results });
      });
    return;
  } else {
    return res.status(400).send({ error: "Unsupported file type" });
  }

  const results = await checkMany(numbers, ip);
  fs.unlinkSync(file.path);
  res.json({ results });
});


async function checkMany(numbers, ip) {
  resetIfNeeded();
  const usage = getUserUsage(ip);
  const results = [];

  for (const number of numbers) {
    // Check limits BEFORE calling WhatsApp API
    if (usage.users[ip].daily >= 10) {
      results.push({ number, exists: null, error: "Daily limit reached." });
      continue; // skip this number
    }
    if (usage.users[ip].monthly >= 100) {
      results.push({ number, exists: null, error: "Monthly limit reached." });
      continue; // skip this number
    }

    try {
      const result = await sock.onWhatsApp(`${number}@s.whatsapp.net`);
      const exists = result?.[0]?.exists || false;

      // ✅ Increment usage only after a successful check
      usage.users[ip].daily++;
      usage.users[ip].monthly++;
      saveUsage(usage);

      results.push({ number, exists });
    } catch {
      results.push({ number, exists: null, error: "Error checking" });
    }
  }

  return results;
}




app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});