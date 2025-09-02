import express from "express";
import "dotenv/config";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import router from "../routes/game.js";
import authrouter from "../routes/auth.js";

const app = express();
// const PORT = process.env.PORT || 3000;



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

app.get("/", (req, res) => {
  res.send("Hello from server");
});

app.use("/api", router);
app.use("/api/auth", authrouter);



// app.listen(PORT, () => {
//   console.log(`🚀 Maveli Runner Server running on port ${PORT}`);
//   console.log(`📡 API Base URL: http://localhost:${PORT}/`);
// });

// export default app;
export default function handler(req, res) {
  app(req, res);
}