// Express route chains keep every verb in the chain; Fastify route objects can list methods.
router.route("/books/:id").get(getBook).put(updateBook); // seam: route GET /books/{}; route PUT /books/{}
fastify.route({ method: ["GET", "HEAD"], url: "/health", handler }); // seam: route GET /health; route HEAD /health
