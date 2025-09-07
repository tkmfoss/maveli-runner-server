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
  MAX_GAME_DURATION: 999999999999999, 
  MIN_SCORE_PER_SECOND: 10, 
  MAX_SCORE_PER_SECOND: 30, 
  MAX_SCORE_LIMIT: 15000000, 
  COOLDOWN_PERIOD: 3000,
  PHYSICS_TOLERANCE: 0.5,
  MIN_EVENTS: 2,
  MAX_EVENTS: 999999999999999, 
  SESSION_TIMEOUT: 86400000, // 24 hours in ms (reduced from extremely large value)
  MAX_SUBMISSION_DELAY: 999999999999999, 
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

async function validateGameSession(gameSession, finalScore, userId, sessionKey) {
  console.log(`=== STARTING VALIDATION for user ${userId} ===`);
  console.log(`Validating game session for user ${userId}:`, {
    score: finalScore,
    duration: gameSession.duration,
    events: gameSession.events?.length,
    sessionKey: sessionKey
  });

  const { startTime, endTime, duration, events } = gameSession;
  
  // Check 1: Basic data structure
  console.log(`CHECK 1 - Basic data structure:`, {
    hasStartTime: !!startTime,
    hasEndTime: !!endTime,
    hasEvents: !!events,
    eventsIsArray: Array.isArray(events)
  });
  
  if (!startTime || !endTime || !events || !Array.isArray(events)) {
    console.log(`❌ FAILED CHECK 1 - Invalid game data structure`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 1`);

  // Check 2: Session completion status
  console.log(`CHECK 2 - Session completion status:`, {
    sessionAlreadyCompleted: completedSessions.has(sessionKey)
  });

  if (completedSessions.has(sessionKey)) {
    console.log(`❌ FAILED CHECK 2 - Game session already completed`);
    return { valid: false, reason: "Game session expired" };
  }
  console.log(`✅ PASSED CHECK 2`);

  // Check 3: Active session validation (in-memory + Supabase fallback)
  let userSession = activeGameSessions.get(userId);
  console.log(`CHECK 3 - Active session validation (initial):`, {
    hasActiveSessionInMemory: !!userSession,
    sessionKeyMatchesInMemory: userSession?.sessionKey === sessionKey,
    activeSessionKeyInMemory: userSession?.sessionKey,
    providedSessionKey: sessionKey
  });

  if (!userSession || userSession.sessionKey !== sessionKey) {
    // Fall back to Supabase
    const { data, error } = await supabaseBase
      .from("game_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("session_key", sessionKey)
      .gte("expires_at", new Date().toISOString())
      .single();

    if (error || !data) {
      console.log(`❌ FAILED CHECK 3 - No valid session found in Supabase:`, error?.message);
      return { valid: false, reason: "Game session expired" };
    }

    console.log(`✅ FOUND SESSION IN SUPABASE - Caching in memory`);
    userSession = {
      sessionKey: sessionKey,
      created: new Date(data.created_at).getTime()
    };
    activeGameSessions.set(userId, userSession);
  } else {
    console.log(`✅ PASSED CHECK 3 - Found in-memory session`);
  }
  console.log(`✅ PASSED CHECK 3`);

  // Check 4: Submission delay
  const gameEndTime = new Date(endTime).getTime();
  const submissionDelay = Date.now() - gameEndTime;
  console.log(`CHECK 4 - Submission delay:`, {
    gameEndTime: new Date(endTime).toISOString(),
    currentTime: new Date().toISOString(),
    submissionDelay: submissionDelay,
    maxAllowedDelay: GAME_CONSTANTS.MAX_SUBMISSION_DELAY,
    requireFreshGame: GAME_CONSTANTS.REQUIRE_FRESH_GAME
  });
  
  if (GAME_CONSTANTS.REQUIRE_FRESH_GAME && submissionDelay > GAME_CONSTANTS.MAX_SUBMISSION_DELAY) {
    console.log(`❌ FAILED CHECK 4 - Submission delay too long`);
    return { valid: false, reason: "Game session expired" };
  }
  console.log(`✅ PASSED CHECK 4`);

  // Check 5: Events count
  console.log(`CHECK 5 - Events count:`, {
    eventsCount: events.length,
    minRequired: GAME_CONSTANTS.MIN_EVENTS,
    maxAllowed: GAME_CONSTANTS.MAX_EVENTS
  });

  if (events.length < GAME_CONSTANTS.MIN_EVENTS) {
    console.log(`❌ FAILED CHECK 5 - Too few events`);
    return { valid: false, reason: "Invalid game data" };
  }

  if (events.length > GAME_CONSTANTS.MAX_EVENTS) {
    console.log(`❌ FAILED CHECK 5 - Too many events`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 5`);

  // Check 6: Timestamp validation
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();
  const now = Date.now();

  console.log(`CHECK 6 - Timestamp validation:`, {
    startTime: startTime,
    endTime: endTime,
    startTs: startTs,
    endTs: endTs,
    now: now,
    startTsValid: !isNaN(startTs),
    endTsValid: !isNaN(endTs),
    startInFuture: startTs > now,
    endInFuture: endTs > now,
    startAfterEnd: startTs > endTs
  });

  if (isNaN(startTs) || isNaN(endTs)) {
    console.log(`❌ FAILED CHECK 6 - Invalid timestamps (NaN)`);
    return { valid: false, reason: "Invalid game data" };
  }

  if (startTs > now || endTs > now || startTs > endTs) {
    console.log(`❌ FAILED CHECK 6 - Invalid timestamp logic`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 6`);

  // Check 7: Game age validation
  const gameAge = now - startTs;
  const maxGameAge = 6 * 60 * 60 * 1000; // 6 hours
  console.log(`CHECK 7 - Game age validation:`, {
    gameAge: gameAge,
    gameAgeMinutes: Math.round(gameAge / (1000 * 60)),
    maxGameAgeMinutes: Math.round(maxGameAge / (1000 * 60)),
    tooOld: gameAge > maxGameAge
  });

  if (now - startTs > 6 * 60 * 60 * 1000) {
    console.log(`❌ FAILED CHECK 7 - Game too old`);
    return { valid: false, reason: "Game session expired" };
  }
  console.log(`✅ PASSED CHECK 7`);

  // Check 8: Duration consistency
  const calculatedDuration = endTs - startTs;
  const durationDiff = Math.abs(duration - calculatedDuration);
  console.log(`CHECK 8 - Duration consistency:`, {
    providedDuration: duration,
    calculatedDuration: calculatedDuration,
    difference: durationDiff,
    maxAllowedDiff: 10000
  });
  
  if (Math.abs(duration - calculatedDuration) > 10000) { 
    console.log(`❌ FAILED CHECK 8 - Duration inconsistency`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 8`);

  // Check 9: Duration limits
  console.log(`CHECK 9 - Duration limits:`, {
    duration: duration,
    minDuration: GAME_CONSTANTS.MIN_GAME_DURATION,
    maxDuration: GAME_CONSTANTS.MAX_GAME_DURATION,
    tooShort: duration < GAME_CONSTANTS.MIN_GAME_DURATION,
    tooLong: duration > GAME_CONSTANTS.MAX_GAME_DURATION
  });

  if (duration < GAME_CONSTANTS.MIN_GAME_DURATION || duration > GAME_CONSTANTS.MAX_GAME_DURATION) {
    console.log(`❌ FAILED CHECK 9 - Duration out of bounds`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 9`);

  // Check 10: Required events
  const startEvent = events.find(e => e.type === 'game_start');
  const endEvent = events.find(e => e.type === 'collision' || e.type === 'game_over');

  console.log(`CHECK 10 - Required events:`, {
    hasStartEvent: !!startEvent,
    hasEndEvent: !!endEvent,
    startEventData: startEvent,
    endEventData: endEvent
  });

  if (!startEvent) {
    console.log(`❌ FAILED CHECK 10 - Missing start event`);
    return { valid: false, reason: "Invalid game data" };
  }

  if (!endEvent) {
    console.log(`❌ FAILED CHECK 10 - Missing end event`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 10`);

  // Check 11: Score limits
  console.log(`CHECK 11 - Score limits:`, {
    finalScore: finalScore,
    maxScoreLimit: GAME_CONSTANTS.MAX_SCORE_LIMIT,
    negative: finalScore < 0,
    tooHigh: finalScore > GAME_CONSTANTS.MAX_SCORE_LIMIT
  });

  if (finalScore < 0 || finalScore > GAME_CONSTANTS.MAX_SCORE_LIMIT) {
    console.log(`❌ FAILED CHECK 11 - Score out of bounds`);
    return { valid: false, reason: "Invalid score data" };
  }
  console.log(`✅ PASSED CHECK 11`);

  // Check 12: Score rate validation
  const scoreRate = (finalScore / duration) * 1000;
  console.log(`CHECK 12 - Score rate validation:`, {
    finalScore: finalScore,
    duration: duration,
    scoreRate: scoreRate,
    minRate: GAME_CONSTANTS.MIN_SCORE_PER_SECOND,
    maxRate: GAME_CONSTANTS.MAX_SCORE_PER_SECOND,
    tooSlow: scoreRate < GAME_CONSTANTS.MIN_SCORE_PER_SECOND,
    tooFast: scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND
  });
  
  if (scoreRate < GAME_CONSTANTS.MIN_SCORE_PER_SECOND || scoreRate > GAME_CONSTANTS.MAX_SCORE_PER_SECOND) {
    console.log(`❌ FAILED CHECK 12 - Score rate invalid: ${scoreRate.toFixed(2)} points/sec`);
    return { valid: false, reason: "Invalid score data" };
  }
  console.log(`✅ PASSED CHECK 12`);

  // Check 13: Physics validation
  const expectedScore = Math.floor(duration / 50);
  const scoreDifference = Math.abs(finalScore - expectedScore);
  
  const baseTolerance = Math.max(200, expectedScore * GAME_CONSTANTS.PHYSICS_TOLERANCE);
  const highScoreTolerance = finalScore > 5000 ? baseTolerance * 2 : baseTolerance;
  
  console.log(`CHECK 13 - Physics validation:`, {
    expectedScore: expectedScore,
    actualScore: finalScore,
    scoreDifference: scoreDifference,
    baseTolerance: baseTolerance,
    highScoreTolerance: highScoreTolerance,
    isHighScore: finalScore > 5000,
    physicsToleranceConstant: GAME_CONSTANTS.PHYSICS_TOLERANCE
  });
  
  if (scoreDifference > highScoreTolerance) {
    console.log(`❌ FAILED CHECK 13 - Physics validation failed: expected ~${expectedScore}, got ${finalScore}, difference ${scoreDifference}, tolerance ${highScoreTolerance}`);
    return { 
      valid: false, 
      reason: "Invalid score data"
    };
  }
  console.log(`✅ PASSED CHECK 13`);

  // Check 14: Jump behavior analysis
  const jumpEvents = events.filter(e => e.type === 'jump');
  console.log(`CHECK 14 - Jump behavior analysis:`, {
    totalJumps: jumpEvents.length,
    hasJumps: jumpEvents.length > 0
  });
  
  if (jumpEvents.length > 0) {
    const jumpIntervals = [];
    for (let i = 1; i < jumpEvents.length; i++) {
      jumpIntervals.push(jumpEvents[i].timestamp - jumpEvents[i-1].timestamp);
    }

    console.log(`CHECK 14a - Jump intervals:`, {
      jumpIntervalsCount: jumpIntervals.length,
      minInterval: jumpIntervals.length > 0 ? Math.min(...jumpIntervals) : 'N/A',
      maxInterval: jumpIntervals.length > 0 ? Math.max(...jumpIntervals) : 'N/A',
      avgInterval: jumpIntervals.length > 0 ? Math.round(jumpIntervals.reduce((a,b) => a+b, 0) / jumpIntervals.length) : 'N/A'
    });

    if (jumpIntervals.length > 10) { 
      const fastReactions = jumpIntervals.filter(interval => interval < 50);
      const maxFastReactionRatio = duration > 300000 ? 0.5 : 0.3;
      const actualFastReactionRatio = fastReactions.length / jumpIntervals.length;
      
      console.log(`CHECK 14b - Fast reaction analysis:`, {
        fastReactions: fastReactions.length,
        totalIntervals: jumpIntervals.length,
        actualRatio: actualFastReactionRatio,
        maxAllowedRatio: maxFastReactionRatio,
        durationLong: duration > 300000,
        tooManyFastReactions: actualFastReactionRatio > maxFastReactionRatio
      });
      
      if (fastReactions.length > jumpIntervals.length * maxFastReactionRatio) {
        console.log(`❌ FAILED CHECK 14 - Too many fast reactions`);
        return { valid: false, reason: "Invalid game data" };
      }
    }
  }
  console.log(`✅ PASSED CHECK 14`);

  // Check 15: Jump vs obstacle analysis
  const obstacleSpawns = events.filter(e => e.type === 'obstacle_spawn').length;
  
  console.log(`CHECK 15 - Jump vs obstacle analysis:`, {
    obstacleSpawns: obstacleSpawns,
    jumpEvents: jumpEvents.length,
    finalScore: finalScore,
    jumpToObstacleRatio: obstacleSpawns > 0 ? (jumpEvents.length / obstacleSpawns) : 'N/A'
  });
  
  if (finalScore > 1000 && jumpEvents.length < obstacleSpawns * 0.7) {
    console.log(`❌ FAILED CHECK 15a - Jump validation failed: ${jumpEvents.length} jumps for ${obstacleSpawns} obstacles`);
    return { valid: false, reason: "Invalid game data" };
  }
  
  if (finalScore > 500 && jumpEvents.length === 0) {
    console.log(`❌ FAILED CHECK 15b - No jumps for high score`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 15`);
  
  // Check 16: Integrity violations
  const integrityViolations = events.filter(e => e.type === 'integrity_violation');
  console.log(`CHECK 16 - Integrity violations:`, {
    integrityViolations: integrityViolations.length,
    violations: integrityViolations
  });
  
  if (integrityViolations.length > 0) {
    console.log(`❌ FAILED CHECK 16 - Integrity violation detected in events`);
    return { valid: false, reason: "Invalid game data" };
  }
  console.log(`✅ PASSED CHECK 16`);

  // Delete the session from Supabase after successful validation
  const { error: deleteError } = await supabaseBase
    .from("game_sessions")
    .delete()
    .eq("user_id", userId)
    .eq("session_key", sessionKey);

  if (deleteError) {
    console.error(`Warning: Failed to delete session from Supabase:`, deleteError);
  } else {
    console.log(`Session deleted from Supabase successfully`);
  }

  completedSessions.add(sessionKey);
  
  console.log(`🎉 ALL CHECKS PASSED - High score game session validation successful for user ${userId}`);
  console.log(`=== VALIDATION COMPLETE ===`);
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
    
    const { user, supabase } = auth;
    const sessionKey = generateSimpleSessionKey(user.id);
    const expiresAt = new Date(Date.now() + GAME_CONSTANTS.SESSION_TIMEOUT).toISOString();

    // Store session in Supabase
    const { error: insertError } = await supabase
      .from("game_sessions")
      .insert({
        user_id: user.id,
        session_key: sessionKey,
        created_at: new Date().toISOString(),
        expires_at: expiresAt
      });

    if (insertError) {
      console.error("Failed to store session in Supabase:", insertError);
      return res.status(500).json({ error: "Failed to create game session" });
    }

    // Cache in memory for quick access
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

    const validation = await validateGameSession(gameSession, score, user.id, sessionKey);
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

// Cleanup interval for expired sessions (in-memory and Supabase)
setInterval(async () => {
  const now = Date.now();
  let cleaned = 0;
  
  // Clean in-memory sessions
  for (const [userId, session] of activeGameSessions.entries()) {
    if (now - session.created > GAME_CONSTANTS.SESSION_TIMEOUT) {
      activeGameSessions.delete(userId);
      cleaned++;
    }
  }

  // Clean expired sessions in Supabase
  const { error: deleteError } = await supabaseBase
    .from("game_sessions")
    .delete()
    .lte("expires_at", new Date().toISOString());

  if (deleteError) {
    console.error("Failed to clean up expired sessions in Supabase:", deleteError);
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired game sessions`);
  }
}, 5 * 60 * 1000); // Every 5 minutes

export default router;