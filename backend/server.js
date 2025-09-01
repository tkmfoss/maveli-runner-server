import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import router from "./routes/game.js";
import authrouter from "./routes/auth.js";

const app = express();
const PORT = process.env.PORT || 3000;



app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://127.0.0.1:5500",
    credentials: true,
  }),
);

app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
    console.log("Hello from server");
});

app.use("/api", router);
app.use("/api/auth", authrouter);



app.listen(PORT, () => {
  console.log(`🚀 Maveli Runner Server running on port ${PORT}`);
  console.log(`📡 API Base URL: http://localhost:${PORT}/`);
});

export default app;