import express from "express";
import "dotenv/config";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import helmet from "helmet";
import morgan from "morgan";
import router from "./routes/game.js";
import authrouter from "./routes/auth.js";

const app = express();

// For Vercel serverless functions, we don't need to specify PORT
// Vercel handles this automatically

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "*", // Allow all origins in development
    credentials: true,
  })
);

app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.json({ 
    message: "Maveli Runner API is running!",
    status: "OK",
    timestamp: new Date().toISOString()
  });
});

app.get("/api", (req, res) => {
  res.json({ 
    message: "API endpoint working",
    status: "OK"
  });
});

app.use("/api", router);
app.use("/api/auth", authrouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Handle 404
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// For Vercel serverless functions, export the app
export default app;