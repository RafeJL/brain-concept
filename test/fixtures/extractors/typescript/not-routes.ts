// None of these register routes. Calls on client-named receivers are HTTP calls; the settings
// lookup and the cache read are neither.
axios.post("/articles", data); // seam: call POST /articles
api.get("/x", config); // seam: call GET /x
settings.get("title");
cache.get("/key", fallback);
