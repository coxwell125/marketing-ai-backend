import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import chatRouter from "./routes/chat";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "marketing-ai-backend" });
});

app.use("/api/chat", chatRouter);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`✅ Backend running on port ${port}`);
});
