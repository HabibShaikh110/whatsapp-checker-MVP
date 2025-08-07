const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: "yourSecretKeyHere",
    resave: false,
    saveUninitialized: true,
  })
);

const USERS_FILE = "users.json";

// Load users from file
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

// Save users to file
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Middleware to protect routes
function isLoggedIn(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).send("Please log in");
  }
}
app.post("/register", async (req, res) => {
    const { email, password, plan } = req.body;
    const users = loadUsers();
  
    if (users.find((u) => u.email === email)) {
      return res.status(400).send("Email already registered");
    }
  
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: Date.now().toString(),
      email,
      password: hashedPassword,
      plan: plan || "free",
      checksToday: 0,
      bulkChecksThisMonth: 0,
    };
  
    users.push(newUser);
    saveUsers(users);
    req.session.userId = newUser.id;
    res.redirect("/index.html"); // or /dashboard
  });
  app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    const users = loadUsers();
    const user = users.find((u) => u.email === email);
    if (!user) return res.status(401).send("Invalid email or password");
  
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send("Invalid email or password");
  
    req.session.userId = user.id;
    res.redirect("/index.html");
  });
  app.get("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/login.html");
    });
  });
      