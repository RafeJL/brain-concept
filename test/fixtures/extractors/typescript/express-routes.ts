import { Router } from "express";

// Express routes: a static path starting with "/" plus handler or middleware arguments.
const router = Router();

router.get("/articles", auth.optional, async (req, res) => {}); // seam: route GET /articles
router.post( // seam: route POST /articles/{}/comments
  "/articles/:slug/comments",
  auth.required,
  handler,
);
app.delete("/users/:id", (req, res) => res.end()); // seam: route DELETE /users/{}

export default router;
