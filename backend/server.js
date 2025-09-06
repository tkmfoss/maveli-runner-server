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
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);
app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));


app.get("/", async (req, res) => {
  res.send("Hello you are verified you can login now");
});

app.use("/api", router);
app.use("/api/auth", authrouter);


app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/`);
});

export default app;