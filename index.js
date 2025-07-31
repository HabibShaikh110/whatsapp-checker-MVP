const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const qrcode = require("qrcode-terminal");
const SESSION_PATH = './sessions';
const path = require("path");
const {makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

let connectionStatus = "loading";
let lastQR = null;
let sock;


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

app.post("/check", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
