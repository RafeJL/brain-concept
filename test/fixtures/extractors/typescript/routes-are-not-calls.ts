// Route registrations, including route chains, are never counted as calls as well.
router.get("/articles", auth, handler); // seam: route GET /articles
router.route("/b").get(h); // seam: route GET /b
