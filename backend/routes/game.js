import express from "express";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

const router = express.Router();
const supabaseBase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Simplified game constants - only 2 events needed
const GAME_CONSTANTS = {
  MIN_GAME_DURATION: 1000,
  MAX_SCORE_PER_SECOND: 25, 
  MAX_SCORE_LIMIT: 1500000,
  COOLDOWN_PERIOD: 3000
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

// SIMPLIFIED: Only validate 2 events - game_start and collision
function validateGameSession(gameSession, finalScore) {
  const { startTime, endTime, duration, events } = gameSession;
  
  // Basic structure validation
  if (!startTime || !endTime || !events || !Array.isArray(events)) {
    return { valid: false, reason: "Invalid game session data structure" };
  }

  // Should have exactly 2 events: game_start and collision
  if (events.length !== 2) {
    console.log(`Expected 2 events, got ${events.length}:`, events.map(e => e.type));
    return { valid: false, reason: `Expected exactly 2 events, got ${events.length}` };
  }

  const now = Date.now();
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();

  // Timestamp validation
  if (isNaN(startTs) || isNaN(endTs)) {
    return { valid: false, reason: "Invalid timestamp format" };
  }

  if (startTs > now || endTs > now || startTs > endTs) {
    return { valid: false, reason: "Invalid timestamp values" };
  }

  // Duration validation
  const calculatedDuration = endTs - startTs;
  if (Math.abs(duration - calculatedDuration) > 2000) { 
    return { valid: false, reason: "Duration mismatch with timestamps" };
  }

  if (duration < GAME_CONSTANTS.MIN_GAME_DURATION) {
    return { valid: false, reason: "Game duration too short" };
  }

  // Validate the 2 events
  const startEvent = events[0];
  const endEvent = events[1];

  // First event should be game_start
  if (!startEvent || startEvent.type !== 'game_start') {
    console.log('First event invalid:', startEvent);
    return { valid: false, reason: "First event must be game_start" };
  }

  // Second event should be collision
  if (!endEvent || endEvent.type !== 'collision') {
    console.log('Second event invalid:', endEvent);
    return { valid: false, reason: "Second event must be collision" };
  }

  // Validate event structure
  if (typeof startEvent.timestamp !== 'number' || typeof endEvent.timestamp !== 'number') {
    return { valid: false, reason: "Invalid event timestamp types" };
  }

  // Start event should be at timestamp 0 or very close to 0
  if (startEvent.timestamp > 100) {
    return { valid: false, reason: "Start event timestamp should be near 0" };
  }

  // End event should be after start event
  if (endEvent.timestamp <= startEvent.timestamp) {
    return { valid: false, reason: "End event must be after start event" };
  }

  // Score validation - much simpler, just check if reasonable
  if (finalScore < 0 || finalScore > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
    return { valid: false, reason: "Invalid final score range" };
  }

  // Score rate validation (points per second)
  const scoreRate = (finalScore / duration) * 1000;
  if (scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND) {
    console.log(`Score rate too high: ${scoreRate} points/second`);
    return { valid: false, reason: "Score rate too high" };
  }

  // Basic sanity check: score should roughly match duration (1 point per 50ms = 20 points/second)
  const expectedScore = Math.floor(duration / 50);
  const scoreDifference = Math.abs(finalScore - expectedScore);
  const tolerance = Math.max(50, expectedScore * 0.1); // 10% tolerance or 50 points minimum

  if (scoreDifference > tolerance) {
    console.log(`Score vs duration mismatch: score ${finalScore}, expected ~${expectedScore}, difference ${scoreDifference}`);
    return { valid: false, reason: "Score doesn't match game duration" };
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
      console.log("User authentication failed:", userError?.message || "User not found");
      res.status(401).json({ error: "Invalid or expired token" });
      return null;
    }
    
    return { user, supabase };
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
    return null;
  }
}

// Helper function to get or create user profile
async function getOrCreateProfile(userId, supabase, userName = "Anonymous") {
  const { data: profileData, error: fetchError } = await supabase
    .from("USER_PROFILES")
    .select("score, last_updated")
    .eq("user_id", userId)
    .single();

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      console.log(`Creating missing profile for user ${userId}`);
      const { data: newProfile, error: createError } = await supabase
        .from("USER_PROFILES")
        .insert({
          user_id: userId,
          user_name: userName,
          score: 0,
          last_updated: new Date().toISOString()
        })
        .select("score, last_updated")
        .single();
      
      if (createError) {
        throw new Error("Failed to create user profile");
      }
      return newProfile;
    } else {
      throw new Error("Failed to fetch user profile");
    }
  }
  
  return profileData;
}

router.post("/scoreupdate", scoreUpdateLimiter, async (req, res) => {
  try {
    const auth = await authenticateUser(req, res);
    if (!auth) return;
    
    const { user, supabase } = auth;
    const { score, gameSession } = req.body;

    // Validate score format
    if (typeof score !== "number" || score < 0 || !Number.isInteger(score)) {
      return res.status(400).json({ error: "Invalid score format" });
    }

    if (score > GAME_CONSTANTS.MAX_SCORE_LIMIT) { 
      return res.status(400).json({ error: "Score exceeds maximum allowed" });
    }

    // Game session is required
    if (!gameSession) {
      return res.status(400).json({ error: "Game session data required" });
    }

    // SIMPLIFIED VALIDATION: Only check for 2 events
    console.log(`Validating simplified game session for user ${user.id}, score ${score}, events count: ${gameSession.events?.length || 0}`);
    
    const validation = validateGameSession(gameSession, score);
    if (!validation.valid) {
      console.log(`Game session validation failed for user ${user.id}: ${validation.reason}`);
      return res.status(400).json({ error: `Invalid game session: ${validation.reason}` });
    }

    console.log(`Game session validation passed for user ${user.id}`);

    // Get or create user profile
    let currentProfile;
    try {
      currentProfile = await getOrCreateProfile(
        user.id, 
        supabase, 
        user.user_metadata?.username || "Anonymous"
      );
    } catch (error) {
      console.error("Profile error:", error);
      return res.status(500).json({ error: error.message });
    }

    const currentHighScore = currentProfile?.score || 0;
    const lastUpdated = currentProfile?.last_updated;

    // Cooldown check
    if (lastUpdated) {
      const timeSinceLastUpdate = Date.now() - new Date(lastUpdated).getTime();
      if (timeSinceLastUpdate < GAME_CONSTANTS.COOLDOWN_PERIOD) { 
        return res.status(429).json({ 
          error: "Please wait before submitting another score",
          cooldownRemaining: Math.ceil((GAME_CONSTANTS.COOLDOWN_PERIOD - timeSinceLastUpdate) / 1000)
        });
      }
    }

    // Check if score is higher than current high score
    if (score <= currentHighScore) {
      return res.json({
        success: false,
        message: "Score not higher than current high score",
        currentHighScore,
        submittedScore: score
      });
    }

    // Update the score
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

    console.log(`Score update successful for user ${user.id}: ${score}`);

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
    
    let profile;
    try {
      profile = await getOrCreateProfile(
        user.id, 
        supabase, 
        user.user_metadata?.username || "Anonymous"
      );
    } catch (error) {
      console.error("Profile error:", error);
      return res.status(500).json({ error: error.message });
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