import express from "express";
import "dotenv/config";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import helmet from "helmet";
import morgan from "morgan";
import router from "./routes/game.js";
import authrouter from "./routes/auth.js";

const app = express();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(
  cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Logging middleware
app.use(morgan("combined"));

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    message: "Maveli Runner API is running!",
    status: "OK",
    timestamp: new Date().toISOString()
  });
});

// API health check
app.get("/api", (req, res) => {
  res.json({ 
    message: "API endpoint working",
    status: "OK"
  });
});

// API routes
app.use("/api", router);
app.use("/api/auth", authrouter);

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({ 
    error: isDevelopment ? err.message : "Internal server error",
    ...(isDevelopment && { stack: err.stack })
  });
});

// Handle 404 for all other routes
app.use("*", (req, res) => {
  res.status(404).json({ 
    error: "Route not found",
    path: req.originalUrl 
  });
});

// Export for Vercel
export default app;