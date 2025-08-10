// index.js
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const cors = require("cors");
require("dotenv").config();

// ===== Firebase Admin Init =====
const serviceAccount = require("./firebase-key.json"); // your private key file

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const PLAN_LIMITS = {
  free: {
    singleCheckLimitPerDay: 10,
    bulkCheckLimitPerMonth: 100,
  },
  starter: {
    singleCheckLimitPerDay: Infinity,
    bulkCheckLimitPerMonth: 10000,
  },
  power: {
    singleCheckLimitPerDay: Infinity,
    bulkCheckLimitPerMonth: Infinity,
  },
};

// ===== Helper: Get or Create User Record =====
async function getUserData(userId) {
  const userRef = db.collection("users").doc(userId);
  const docSnap = await userRef.get();

  if (!docSnap.exists) {
    const defaultData = {
      plan: "free",
      usage: {
        singleChecksToday: 0,
        bulkChecksThisMonth: 0,
      },
      lastUpdated: admin.firestore.Timestamp.now(),
    };
    await userRef.set(defaultData);
    return defaultData;
  }
  return docSnap.data();
}

// ===== Helper: Reset counts if new day/month =====
function resetIfNewPeriod(userData) {
  const now = new Date();
  const lastUpdated = userData.lastUpdated.toDate();

  // Daily reset for single checks
  if (
    now.getDate() !== lastUpdated.getDate() ||
    now.getMonth() !== lastUpdated.getMonth() ||
    now.getFullYear() !== lastUpdated.getFullYear()
  ) {
    userData.usage.singleChecksToday = 0;
  }

  // Monthly reset for bulk checks
  if (
    now.getMonth() !== lastUpdated.getMonth() ||
    now.getFullYear() !== lastUpdated.getFullYear()
  ) {
    userData.usage.bulkChecksThisMonth = 0;
  }

  return userData;
}

// ===== Simulated Check Function (Replace with your real WhatsApp API logic) =====
async function checkNumber(number) {
  await new Promise((resolve) => setTimeout(resolve, 200)); // simulate delay
  return Math.random() > 0.3 ? "✅ Active" : "❌ Not Found"; // simulate result
}

// ===== Single Check Route =====
app.post("/check-single", async (req, res) => {
  const { userId, number } = req.body;
  if (!userId || !number) {
    return res.status(400).json({ error: "Missing userId or number" });
  }

  let userData = await getUserData(userId);
  userData = resetIfNewPeriod(userData);

  const planLimits = PLAN_LIMITS[userData.plan];
  if (userData.usage.singleChecksToday >= planLimits.singleCheckLimitPerDay) {
    return res.json({ result: "⚠️ Daily single check limit reached" });
  }

  // Perform check
  const result = await checkNumber(number);

  // Update usage
  userData.usage.singleChecksToday += 1;
  userData.lastUpdated = admin.firestore.Timestamp.now();
  await db.collection("users").doc(userId).set(userData);

  res.json({ result });
});

// ===== Bulk Check Route =====
app.post("/check-bulk", async (req, res) => {
  const { userId, numbers } = req.body;
  if (!userId || !Array.isArray(numbers)) {
    return res.status(400).json({ error: "Missing userId or numbers array" });
  }

  let userData = await getUserData(userId);
  userData = resetIfNewPeriod(userData);

  const planLimits = PLAN_LIMITS[userData.plan];
  const results = [];

  for (let number of numbers) {
    if (userData.usage.bulkChecksThisMonth >= planLimits.bulkCheckLimitPerMonth) {
      // Append "limit reached" instead of stopping
      results.push({ number, result: "⚠️ Bulk check limit reached" });
    } else {
      const result = await checkNumber(number);
      results.push({ number, result });

      // Update usage count
      userData.usage.bulkChecksThisMonth += 1;
    }
  }

  userData.lastUpdated = admin.firestore.Timestamp.now();
  await db.collection("users").doc(userId).set(userData);

  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
