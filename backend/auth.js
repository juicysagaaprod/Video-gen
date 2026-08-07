import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createUser, getUserByEmail, getUserById } from "./db.js";

const SIGNUP_CREDIT_CENTS = 500; // $5 of starting credit for new accounts
const COOKIE_NAME = "seedance_session";
const isProd = process.env.NODE_ENV === "production";

function getJwtSecret() {
  return process.env.JWT_SECRET;
}

export function requireJwtSecret() {
  if (!getJwtSecret()) {
    throw new Error(
      "JWT_SECRET is not set. Generate one (e.g. `openssl rand -hex 32`) and add it to backend/.env."
    );
  }
}

function signSession(userId) {
  return jwt.sign({ sub: userId }, getJwtSecret(), { expiresIn: "30d" });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: "Session no longer valid." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired or invalid." });
  }
}

function isValidEmail(email) {
  return typeof email === "string" && /^\S+@\S+\.\S+$/.test(email);
}

export function registerAuthRoutes(app) {
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!isValidEmail(email) || typeof password !== "string" || password.length < 8) {
        return res
          .status(400)
          .json({ error: "Valid email and an 8+ character password are required." });
      }
      if (getUserByEmail(email)) {
        return res.status(409).json({ error: "An account with that email already exists." });
      }
      const hash = await bcrypt.hash(password, 12);
      const user = createUser(email, hash);
      setSessionCookie(res, signSession(user.id));
      res.json({ id: user.id, email: user.email, creditsCents: user.credits_cents });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not create account." });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = getUserByEmail(email || "");
      if (!user) return res.status(401).json({ error: "Incorrect email or password." });
      const ok = await bcrypt.compare(password || "", user.password_hash);
      if (!ok) return res.status(401).json({ error: "Incorrect email or password." });
      setSessionCookie(res, signSession(user.id));
      res.json({ id: user.id, email: user.email, creditsCents: user.credits_cents });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not sign in." });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", authMiddleware, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, creditsCents: req.user.credits_cents });
  });
}

export { SIGNUP_CREDIT_CENTS };
