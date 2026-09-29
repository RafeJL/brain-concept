import { Router } from "express";
const router = Router();
router.get("/articles/:slug", auth.optional, handler);
router.delete("/articles/:slug", auth.required, remove);
export default router;
