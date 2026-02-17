import "dotenv/config";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import chatRoutes from "./routes/chat";
import { logger } from "./utils/logger";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", chatRoutes);

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  logger.info({ port }, "Marketing AI backend running");
});
