// HTTP clients called with URLs known only at run time are recorded without a key.
// Lookups on receivers that are not HTTP clients are skipped.
const API = "https://api.example.com/v1";

superagent.get(`${API_ROOT}${url}`); // seam: call GET <run-time>
fetch(url); // seam: call GET <run-time>
store.get(key);
map.get("user");

// A known base followed directly by a run-time path: the path itself is unknown, so these are
// run-time URLs, not calls to "/v1/{}".
axios.get(API + path); // seam: call GET <run-time>
requests.get(`${API}${path}`); // seam: call GET <run-time>

// A separator doesn't make it known: a value named like a URL or path supplies the rest of it.
// An id after a separator is an ordinary path parameter.
requests.get(`${API}/${options.relativeUrl}`); // seam: call GET <run-time>
requests.get(`${API}/orders/${orderId}`); // seam: call GET /v1/orders/{}
