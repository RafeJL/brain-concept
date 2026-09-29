// HTTP clients called with URLs known only at run time are recorded without a key.
// Lookups on receivers that are not HTTP clients are skipped.
superagent.get(`${API_ROOT}${url}`); // seam: call GET <run-time>
fetch(url); // seam: call GET <run-time>
store.get(key);
map.get("user");
