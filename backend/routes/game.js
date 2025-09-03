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
  MAX_GAME_DURATION: 600000,
  MIN_SCORE_PER_SECOND: 15,
  MAX_SCORE_PER_SECOND: 25,
  MAX_SCORE_LIMIT: 1500000,
  COOLDOWN_PERIOD: 3000,
  PHYSICS_TOLERANCE: 0.2,
  MIN_EVENTS: 2,
  MAX_EVENTS: 500,
  SESSION_TIMEOUT: 1800000,
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

const activeSessions = new Map();

function generateSessionToken(userId) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(16).toString('hex');
  const data = `${userId}-${timestamp}-${random}`;
  
  const secret = process.env.GAME_SESSION_SECRET || 'default-secret-change-this';
  const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  
  return `${Buffer.from(data).toString('base64')}.${signature}`;
}

function verifySessionToken(token, userId) {
  try {
    if (!token || typeof token !== 'string') return false;
    
    const [dataB64, signature] = token.split('.');
    if (!dataB64 || !signature) return false;
    
    const data = Buffer.from(dataB64, 'base64').toString();
    const secret = process.env.GAME_SESSION_SECRET || 'default-secret-change-this';
    const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
      console.log('Session token signature mismatch');
      return false;
    }
    
    const [tokenUserId, timestamp] = data.split('-');
    if (tokenUserId !== userId) {
      console.log('Session token user ID mismatch');
      return false;
    }
    
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > GAME_CONSTANTS.SESSION_TIMEOUT) {
      console.log('Session token expired');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Session token verification error:', error);
    return false;
  }
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

function validateGameSession(gameSession, finalScore, userId) {
  console.log(`Validating game session for user ${userId}:`, {
    score: finalScore,
    duration: gameSession.duration,
    events: gameSession.events?.length
  });

  const { startTime, endTime, duration, events, sessionToken } = gameSession;
  
  if (!startTime || !endTime || !events || !Array.isArray(events)) {
    return { valid: false, reason: "Invalid game session data structure" };
  }

  if (sessionToken) {
    if (!verifySessionToken(sessionToken, userId)) {
      console.log('Session token verification failed, but continuing validation...');
    }
  }

  if (events.length < GAME_CONSTANTS.MIN_EVENTS) {
    return { valid: false, reason: `Too few events: ${events.length} (minimum ${GAME_CONSTANTS.MIN_EVENTS})` };
  }

  if (events.length > GAME_CONSTANTS.MAX_EVENTS) {
    return { valid: false, reason: `Too many events: ${events.length} (maximum ${GAME_CONSTANTS.MAX_EVENTS})` };
  }

  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();
  const now = Date.now();

  if (isNaN(startTs) || isNaN(endTs)) {
    return { valid: false, reason: "Invalid timestamp format" };
  }

  if (startTs > now || endTs > now || startTs > endTs) {
    return { valid: false, reason: "Invalid timestamp values" };
  }

  const calculatedDuration = endTs - startTs;
  if (Math.abs(duration - calculatedDuration) > 5000) {
    return { valid: false, reason: "Duration mismatch with timestamps" };
  }

  if (duration < GAME_CONSTANTS.MIN_GAME_DURATION || duration > GAME_CONSTANTS.MAX_GAME_DURATION) {
    return { valid: false, reason: `Invalid game duration: ${duration}ms` };
  }

  const startEvent = events.find(e => e.type === 'game_start');
  const endEvent = events.find(e => e.type === 'collision' || e.type === 'game_over');

  if (!startEvent) {
    return { valid: false, reason: "Missing game_start event" };
  }

  if (!endEvent) {
    return { valid: false, reason: "Missing collision/game_over event" };
  }

  if (finalScore < 0 || finalScore > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
    return { valid: false, reason: `Score out of range: ${finalScore}` };
  }

  const scoreRate = (finalScore / duration) * 1000;
  
  if (scoreRate < GAME_CONSTANTS.MIN_SCORE_PER_SECOND || scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND) {
    return { valid: false, reason: `Invalid score rate: ${scoreRate.toFixed(2)} points/sec (expected ${GAME_CONSTANTS.MIN_SCORE_PER_SECOND}-${GAME_CONSTANTS.MAX_SCORE_PER_SECOND})` };
  }

  const expectedScore = Math.floor(duration / 50);
  const scoreDifference = Math.abs(finalScore - expectedScore);
  const tolerance = Math.max(100, expectedScore * GAME_CONSTANTS.PHYSICS_TOLERANCE);

  if (scoreDifference > tolerance) {
    return { 
      valid: false, 
      reason: `Score physics violation - expected ~${expectedScore}, got ${finalScore}, difference ${scoreDifference}` 
    };
  }

  const jumpEvents = events.filter(e => e.type === 'jump');
  if (jumpEvents.length > 0) {
    const jumpIntervals = [];
    for (let i = 1; i < jumpEvents.length; i++) {
      jumpIntervals.push(jumpEvents[i].timestamp - jumpEvents[i-1].timestamp);
    }

    if (jumpIntervals.length > 5) {
      const avgInterval = jumpIntervals.reduce((a, b) => a + b, 0) / jumpIntervals.length;
      const variance = jumpIntervals.reduce((sum, interval) => {
        return sum + Math.pow(interval - avgInterval, 2);
      }, 0) / jumpIntervals.length;

      const stdDev = Math.sqrt(variance);
      
      if (stdDev < 20 && jumpIntervals.length > 10) {
        return { valid: false, reason: "Detected non-human jump patterns" };
      }
    }

    const fastReactions = jumpIntervals.filter(interval => interval < 50);
    if (fastReactions.length > jumpIntervals.length * 0.3) {
      return { valid: false, reason: "Too many impossible reaction times detected" };
    }
  }

  console.log(`Game session validation passed for user ${userId}`);
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
    const sessionToken = generateSessionToken(user.id);
    
    activeSessions.set(user.id, {
      token: sessionToken,
      created: Date.now(),
      used: false
    });
    
    const now = Date.now();
    for (const [userId, session] of activeSessions.entries()) {
      if (now - session.created > GAME_CONSTANTS.SESSION_TIMEOUT) {
        activeSessions.delete(userId);
      }
    }
    
    console.log(`Created game session for user ${user.id}`);
    
    res.json({
      success: true,
      sessionToken,
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
    const { score, gameSession } = req.body;

    if (typeof score !== "number" || score < 0 || !Number.isInteger(score)) {
      return res.status(400).json({ error: "Invalid score format" });
    }

    if (score > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
      return res.status(400).json({ error: "Score exceeds maximum allowed" });
    }

    if (!gameSession || typeof gameSession !== 'object') {
      return res.status(400).json({ error: "Game session data required" });
    }

    const validation = validateGameSession(gameSession, score, user.id);
    if (!validation.valid) {
      console.log(`Game session validation failed for user ${user.id}: ${validation.reason}`);
      
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

    console.log(`Score update successful for user ${user.id}: ${score} (previous: ${currentHighScore})`);

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
      .limit(50);

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
  
  for (const [userId, session] of activeSessions.entries()) {
    if (now - session.created > GAME_CONSTANTS.SESSION_TIMEOUT) {
      activeSessions.delete(userId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired game sessions`);
  }
}, 5 * 60 * 1000);

export default router;