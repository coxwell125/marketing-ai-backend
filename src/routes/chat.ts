import { Router } from "express";
import { z } from "zod";
import { runMarketingAgent } from "../services/openaiAgent";

const router = Router();

const ChatSchema = z.object({
  message: z.string().min(1),
});

router.post("/chat", async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body. Expected: { message: string }" });
  }

  try {
    const result = await runMarketingAgent(parsed.data.message);
    return res.json({ answer: result.text });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

export default router;
