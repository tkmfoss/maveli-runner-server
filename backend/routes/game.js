import express from "express";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

const router = express.Router();

const supabaseBase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const GAME_CONSTANTS = {
  SCORE_INCREMENT_INTERVAL: 50,
  MIN_GAME_DURATION: 1000,
  MAX_SCORE_PER_SECOND: 25, 
  MIN_EVENTS_PER_GAME: 2,
  SCORE_TOLERANCE: 10, 
  DURATION_BUFFER: 5
};

const scoreUpdateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many score update attempts" }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests" }
});

function createAuthenticatedSupabaseClient(token) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );
}

function validateGameSession(gameSession, finalScore) {
  const { startTime, endTime, duration, events } = gameSession;

  if (!startTime || !endTime || !events || !Array.isArray(events)) {
    return { valid: false, reason: "Invalid game session data structure" };
  }

  const now = Date.now();
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();
  
  if (isNaN(startTs) || isNaN(endTs)) {
    return { valid: false, reason: "Invalid timestamp format" };
  }

  if (startTs > now || endTs > now || startTs > endTs) {
    return { valid: false, reason: "Invalid timestamp values" };
  }

  const calculatedDuration = endTs - startTs;
  if (Math.abs(duration - calculatedDuration) > 2000) { 
    return { valid: false, reason: "Duration mismatch with timestamps" };
  }

  if (duration < GAME_CONSTANTS.MIN_GAME_DURATION) {
    return { valid: false, reason: "Game duration too short" };
  }

  if (events.length < GAME_CONSTANTS.MIN_EVENTS_PER_GAME) {
    return { valid: false, reason: "Insufficient game events" };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    if (!event.timestamp || !event.type) {
      return { valid: false, reason: "Invalid event structure" };
    }

    const eventTimestamp = typeof event.timestamp === 'number' && event.timestamp < 1000000000000 
      ? startTs + event.timestamp 
      : new Date(event.timestamp).getTime();
      
    if (isNaN(eventTimestamp) || eventTimestamp < startTs || eventTimestamp > endTs + 1000) {
      return { valid: false, reason: "Event timestamp outside game duration" };
    }
  }

  const scoreIncrements = events.filter(e => e.type === 'score_increment').length;
  const expectedScore = scoreIncrements;
  
  if (Math.abs(finalScore - expectedScore) > GAME_CONSTANTS.SCORE_TOLERANCE) {
    return { valid: false, reason: "Score doesn't match recorded increments" };
  }

  const scoreRate = (finalScore / duration) * 1000;
  if (scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND) {
    return { valid: false, reason: "Score rate too high" };
  }

  return { valid: true };
}

async function authenticateUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Authorization header missing" });
    return null;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Token missing from header" });
    return null;
  }

  const supabase = createAuthenticatedSupabaseClient(token);
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return null;
    }
    
    return { user, supabase };
  } catch (error) {
    res.status(401).json({ error: "Authentication failed" });
    return null;
  }
}

router.post("/scoreupdate", scoreUpdateLimiter, async (req, res) => {
  try {
    const auth = await authenticateUser(req, res);
    if (!auth) return;
    
    const { user, supabase } = auth;
    const { score, gameSession } = req.body;

    if (typeof score !== "number" || score < 0 || !Number.isInteger(score)) {
      return res.status(400).json({ error: "Invalid score format" });
    }

    if (score > 1500000) { 
      return res.status(400).json({ error: "Score exceeds maximum allowed" });
    }

    if (gameSession) {
      const validation = validateGameSession(gameSession, score);
      if (!validation.valid) {
        console.log(`Game session validation failed for user ${user.id}: ${validation.reason}`);
      }
    }

    const { data: currentProfile, error: fetchError } = await supabase
      .from("USER_PROFILES")
      .select("score, last_updated")
      .eq("user_id", user.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error("Database fetch error:", fetchError);
      return res.status(500).json({ error: "Failed to fetch current score" });
    }

    const currentHighScore = currentProfile?.score || 0;
    const lastUpdated = currentProfile?.last_updated;

    if (lastUpdated) {
      const timeSinceLastUpdate = Date.now() - new Date(lastUpdated).getTime();
      if (timeSinceLastUpdate < 3000) { 
        return res.status(429).json({ 
          error: "Please wait before submitting another score",
          cooldownRemaining: Math.ceil((3000 - timeSinceLastUpdate) / 1000)
        });
      }
    }

    if (score <= currentHighScore) {
      return res.json({
        success: false,
        message: "Score not higher than current high score",
        currentHighScore,
        submittedScore: score
      });
    }

    const { error: updateError } = await supabase
      .from("USER_PROFILES")
      .upsert(
        {
          user_id: user.id,
          score: score,
          last_updated: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (updateError) {
      console.error("Database update error:", updateError);
      return res.status(500).json({ error: "Failed to update score" });
    }

    return res.json({
      success: true,
      newHighScore: score,
      previousHighScore: currentHighScore,
      message: "New high score saved!"
    });

  } catch (error) {
    console.error("Score update error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/userscore", generalLimiter, async (req, res) => {
  try {
    const auth = await authenticateUser(req, res);
    if (!auth) return;
    
    const { user, supabase } = auth;

    const { data: profile, error } = await supabase
      .from("USER_PROFILES")
      .select("score")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error("Database fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch user score" });
    }

    return res.json({ score: profile?.score || 0 });

  } catch (error) {
    console.error("User score fetch error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/leaderboard", generalLimiter, async (req, res) => {
  try {
    const { data: userData, error: userError } = await supabaseBase
      .from("USER_PROFILES")
      .select("user_name, score")
      .order("score", { ascending: false })
      .limit(10);

    if (userError) {
      console.error("Leaderboard fetch error:", userError);
      return res.status(500).json({ error: "Failed to fetch leaderboard" });
    }

    const leaderboard = userData?.map((u, i) => ({
      rank: i + 1,
      player: u.user_name || "Anonymous",
      score: u.score || 0
    })) || [];

    res.json({ leaderboard });
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

export default router;