// src/routes/tools.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { runToolByName } from "../services/toolIntegration";

const router = Router();

const BodySchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.any()).optional().default({}),
});

router.post("/run", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const { tool, args } = parsed.data;
    const result = await runToolByName(tool, args || {});
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
