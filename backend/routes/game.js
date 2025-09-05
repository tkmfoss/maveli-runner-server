import express from "express";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";
import crypto from "crypto";


const router = express.Router();
const supabaseBase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);


const GAME_CONSTANTS = {
  MIN_GAME_DURATION: 2000,
  MAX_GAME_DURATION: 6000000000000000, 
  MIN_SCORE_PER_SECOND: 10, 
  MAX_SCORE_PER_SECOND: 30, 
  MAX_SCORE_LIMIT: 15000000, 
  COOLDOWN_PERIOD: 3000,
  PHYSICS_TOLERANCE: 0.5,
  MIN_EVENTS: 2,
  MAX_EVENTS: 5000000000000, 
  SESSION_TIMEOUT: 1800000000000000, 
  MAX_SUBMISSION_DELAY: 3000000000000000, 
  REQUIRE_FRESH_GAME: true,
};


const scoreUpdateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: "Too many score submissions. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});


const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  message: { error: "Too many requests" }
});



const activeGameSessions = new Map(); 
const completedSessions = new Set(); 


function generateSimpleSessionKey(userId) {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `${userId}-${timestamp}-${randomPart}`;
}


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


function validateGameSession(gameSession, finalScore, userId, sessionKey) {
  console.log(`Validating game session for user ${userId}:`, {
    score: finalScore,
    duration: gameSession.duration,
    events: gameSession.events?.length,
    sessionKey: sessionKey
  });


  const { startTime, endTime, duration, events } = gameSession;
  
  if (!startTime || !endTime || !events || !Array.isArray(events)) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (completedSessions.has(sessionKey)) {
    return { valid: false, reason: "Game session expired" };
  }


  const userSession = activeGameSessions.get(userId);
  if (!userSession || userSession.sessionKey !== sessionKey) {
    return { valid: false, reason: "Game session expired" };
  }


  const gameEndTime = new Date(endTime).getTime();
  const submissionDelay = Date.now() - gameEndTime;
  if (GAME_CONSTANTS.REQUIRE_FRESH_GAME && submissionDelay > GAME_CONSTANTS.MAX_SUBMISSION_DELAY) {
    return { valid: false, reason: "Game session expired" };
  }


  if (events.length < GAME_CONSTANTS.MIN_EVENTS) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (events.length > GAME_CONSTANTS.MAX_EVENTS) {
    return { valid: false, reason: "Invalid game data" };
  }


  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();
  const now = Date.now();


  if (isNaN(startTs) || isNaN(endTs)) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (startTs > now || endTs > now || startTs > endTs) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (now - startTs > 6 * 60 * 60 * 1000) {
    return { valid: false, reason: "Game session expired" };
  }


  const calculatedDuration = endTs - startTs;
  if (Math.abs(duration - calculatedDuration) > 10000) { 
    return { valid: false, reason: "Invalid game data" };
  }


  if (duration < GAME_CONSTANTS.MIN_GAME_DURATION || duration > GAME_CONSTANTS.MAX_GAME_DURATION) {
    return { valid: false, reason: "Invalid game data" };
  }


  const startEvent = events.find(e => e.type === 'game_start');
  const endEvent = events.find(e => e.type === 'collision' || e.type === 'game_over');


  if (!startEvent) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (!endEvent) {
    return { valid: false, reason: "Invalid game data" };
  }


  if (finalScore < 0 || finalScore > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
    return { valid: false, reason: "Invalid score data" };
  }


  const scoreRate = (finalScore / duration) * 1000;
  if (scoreRate < GAME_CONSTANTS.MIN_SCORE_PER_SECOND || scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND) {
    console.log(`Score rate validation failed: ${scoreRate.toFixed(2)} points/sec`);
    return { valid: false, reason: "Invalid score data" };
  }


  const expectedScore = Math.floor(duration / 50);
  const scoreDifference = Math.abs(finalScore - expectedScore);
  
  const baseTolerance = Math.max(200, expectedScore * GAME_CONSTANTS.PHYSICS_TOLERANCE);
  const highScoreTolerance = finalScore > 5000 ? baseTolerance * 2 : baseTolerance;
  
  if (scoreDifference > highScoreTolerance) {
    console.log(`Physics validation failed: expected ~${expectedScore}, got ${finalScore}, difference ${scoreDifference}, tolerance ${highScoreTolerance}`);
    return { 
      valid: false, 
      reason: "Invalid score data"
    };
  }


  const jumpEvents = events.filter(e => e.type === 'jump');
  if (jumpEvents.length > 0) {
    const jumpIntervals = [];
    for (let i = 1; i < jumpEvents.length; i++) {
      jumpIntervals.push(jumpEvents[i].timestamp - jumpEvents[i-1].timestamp);
    }


    if (jumpIntervals.length > 10) { 
      const fastReactions = jumpIntervals.filter(interval => interval < 50);
      const maxFastReactionRatio = duration > 300000 ? 0.5 : 0.3;
      
      if (fastReactions.length > jumpIntervals.length * maxFastReactionRatio) {
        return { valid: false, reason: "Invalid game data" };
      }
    }
  }


  const obstacleSpawns = events.filter(e => e.type === 'obstacle_spawn').length;
  
  if (finalScore > 1000 && jumpEvents.length < obstacleSpawns * 0.7) {
      console.log(`Jump validation failed: ${jumpEvents.length} jumps for ${obstacleSpawns} obstacles`);
      return { valid: false, reason: "Invalid game data" };
  }
  
  if (finalScore > 500 && jumpEvents.length === 0) {
      return { valid: false, reason: "Invalid game data" };
  }
  
  const integrityViolations = events.filter(e => e.type === 'integrity_violation');
  if (integrityViolations.length > 0) {
      console.log(`Integrity violation detected in events`);
      return { valid: false, reason: "Invalid game data" };
  }

  completedSessions.add(sessionKey);
  
  console.log(`High score game session validation passed for user ${userId}`);
  return { valid: true };
}


async function authenticateUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }


  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }


  const supabase = createAuthenticatedSupabaseClient(token);
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      console.log("User authentication failed:", userError?.message || "User not found");
      res.status(401).json({ error: "Authentication failed" });
      return null;
    }
    
    return { user, supabase };
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
    return null;
  }
}


async function getOrCreateProfile(userId, supabase, userName = "Player") {
  try {
    const { data: profileData, error: fetchError } = await supabase
      .from("USER_PROFILES")
      .select("score, last_updated")
      .eq("user_id", userId)
      .single();


    if (profileData) {
      console.log(`Found existing profile for user ${userId}`);
      return profileData;
    }


    if (fetchError && fetchError.code === 'PGRST116') {
      console.log(`Creating profile for user ${userId}`);
      
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
        console.error("Failed to create profile:", createError);
        throw new Error("Failed to create user profile");
      }
      
      console.log(`Created new profile for user ${userId}`);
      return newProfile;
    }


    console.error("Database query error:", fetchError);
    throw new Error("Failed to access user profile");
    
  } catch (error) {
    console.error("Profile management error:", error);
    throw error;
  }
}


router.post("/create-session", generalLimiter, async (req, res) => {
  try {
    const auth = await authenticateUser(req, res);
    if (!auth) return;
    
    const { user } = auth;
    const sessionKey = generateSimpleSessionKey(user.id);
    
    activeGameSessions.set(user.id, {
      sessionKey: sessionKey,
      created: Date.now()
    });
    
    const now = Date.now();
    for (const [userId, session] of activeGameSessions.entries()) {
      if (now - session.created > GAME_CONSTANTS.SESSION_TIMEOUT) {
        activeGameSessions.delete(userId);
      }
    }
    
    if (completedSessions.size > 10000) {
      completedSessions.clear();
    }
    
    console.log(`Game session created for user ${user.id}: ${sessionKey}`);
    
    res.json({
      success: true,
      sessionKey: sessionKey,
      maxDuration: GAME_CONSTANTS.MAX_GAME_DURATION,
      serverTime: Date.now()
    });
    
  } catch (error) {
    console.error("Session creation error:", error);
    res.status(500).json({ error: "Failed to create game session" });
  }
});


router.post("/scoreupdate", scoreUpdateLimiter, async (req, res) => {
  try {
    const auth = await authenticateUser(req, res);
    if (!auth) return;
    
    const { user, supabase } = auth;
    const { score, gameSession, sessionKey } = req.body;


    console.log(`High score submission for user ${user.id}:`, {
      score,
      duration: gameSession?.duration,
      events: gameSession?.events?.length,
      sessionKey,
      hasGameSession: !!gameSession
    });


    if (typeof score !== "number" || score < 0 || !Number.isInteger(score)) {
      return res.status(400).json({ error: "Invalid request data" });
    }


    if (score > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
      return res.status(400).json({ error: "Invalid request data" });
    }


    if (!gameSession || typeof gameSession !== 'object') {
      return res.status(400).json({ error: "Invalid request data" });
    }


    if (!sessionKey) {
      return res.status(400).json({ error: "Invalid request data" });
    }


    const validation = validateGameSession(gameSession, score, user.id, sessionKey);
    if (!validation.valid) {
      console.log(`High score validation failed for user ${user.id}: ${validation.reason}`);
      
      return res.status(400).json({ 
        error: `Game validation failed: ${validation.reason}` 
      });
    }


    let currentProfile;
    try {
      currentProfile = await getOrCreateProfile(user.id, supabase, "Player");
    } catch (error) {
      console.error("Profile error:", error);
      return res.status(500).json({ error: "Failed to access user profile" });
    }


    const currentHighScore = currentProfile?.score || 0;
    const lastUpdated = currentProfile?.last_updated;


    if (lastUpdated) {
      const timeSinceLastUpdate = Date.now() - new Date(lastUpdated).getTime();
      if (timeSinceLastUpdate < GAME_CONSTANTS.COOLDOWN_PERIOD) {
        return res.status(429).json({ 
          error: "Please wait before submitting another score",
          cooldownRemaining: Math.ceil((GAME_CONSTANTS.COOLDOWN_PERIOD - timeSinceLastUpdate) / 1000)
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
      .update({
        score: score,
        last_updated: new Date().toISOString()
      })
      .eq("user_id", user.id);


    if (updateError) {
      console.error("Database update error:", updateError);
      return res.status(500).json({ error: "Failed to update score" });
    }

    activeGameSessions.delete(user.id);


    console.log(`HIGH SCORE UPDATE SUCCESSFUL for user ${user.id}: ${score} (previous: ${currentHighScore})`);


    return res.json({
      success: true,
      newHighScore: score,
      previousHighScore: currentHighScore,
      message: "New high score saved!",
      improvement: score - currentHighScore
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
      profile = await getOrCreateProfile(user.id, supabase, "Player");
    } catch (error) {
      console.error("Profile error:", error);
      return res.status(500).json({ error: "Failed to access user profile" });
    }


    return res.json({ 
      score: profile?.score || 0,
      lastUpdated: profile?.last_updated
    });
    
  } catch (error) {
    console.error("User score fetch error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/leaderboard", generalLimiter, async (req, res) => {
  try {
    const { data: userData, error: userError } = await supabaseBase
      .from("USER_PROFILES")
      .select("user_name, score, last_updated")
      .order("score", { ascending: false })
      .limit(10);


    if (userError) {
      console.error("Leaderboard fetch error:", userError);
      return res.status(500).json({ error: "Failed to fetch leaderboard" });
    }


    const leaderboard = userData?.map((u, i) => ({
      rank: i + 1,
      player: u.user_name || "Player",
      score: u.score || 0,
      lastUpdated: u.last_updated
    })) || [];


    res.json({ 
      leaderboard,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});


setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [userId, session] of activeGameSessions.entries()) {
    if (now - session.created > GAME_CONSTANTS.SESSION_TIMEOUT) {
      activeGameSessions.delete(userId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired game sessions`);
  }
}, 5 * 60 * 1000);


export default router;