import express from "express";
import { createClient } from "@supabase/supabase-js";
const authrouter = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

authrouter.post("/signup", async (req, res) => {
  try {
    const { email, pass, username } = req.body;
    if (!email || !pass || !username) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const { data, error } = await supabase.auth.signUp({
      email: email,
      password: pass,
      options: {
        data: {
          username: username,
        },
      },
    });

    if (error) {
      console.error("Error signing up:", error.message);
      return res.status(400).json({ error: error.message });
    }
    return res.json({ user: data.user });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Failed to enter User Credentials" });
  }
});


authrouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error("Error signing in:", error.message);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!data.session || !data.user) {
      return res.status(401).json({ error: "Failed to authenticate user" });
    }

    const username = data.user.user_metadata?.username || null;

    res.json({
      username: username,
      token: data.session.access_token, 
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});




export default authrouter;