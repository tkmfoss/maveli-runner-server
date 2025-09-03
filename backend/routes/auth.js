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

    try {
      const { data: profileData, error: profileError } = await supabase
        .from("USER_PROFILES")
        .insert([
          {
            user_id: data.user.id,
            user_name: username,  
            score: 0,            
            last_updated: new Date().toISOString()
          }
        ]);

      if (profileError) {
        console.error("Error inserting user profile:", profileError.message);
  
        console.log("Profile creation failed, will be created on first score access");
      }
    } catch (profileError) {
      console.error("Profile creation error:", profileError);
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

authrouter.post("/verify", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Token missing" });
    }

    const supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
      {
        global: {
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    );

    const { data: { user }, error } = await supabaseClient.auth.getUser(token);
    
    if (error || !user) {
      console.log("Token verification failed:", error?.message || "User not found");
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    return res.json({ valid: true, user_id: user.id });
    
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({ error: "Token verification failed" });
  }
});

export default authrouter;
