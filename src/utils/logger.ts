import pino from "pino";

export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  redact: ["req.headers.authorization", "OPENAI_API_KEY"],
});
