// Literal, template and concatenated URLs resolve; a leading base URL is dropped and later
// run-time values become parameters. The query string is not part of the path.
const API = "https://api.example.com/v1";

requests.get("/user"); // seam: call GET /user
requests.del(`/articles/${slug}/comments/${id}`); // seam: call DELETE /articles/{}/comments/{}
axios.post(API + "/orders/" + id, body); // seam: call POST /v1/orders/{}
fetch(`${API_ROOT}/tags?limit=${n}`); // seam: call GET /tags
fetch("/login", { method: "POST" }); // seam: call POST /login
this.http.put(`/profiles/${name}`, body); // seam: call PUT /profiles/{}
axios({ url: "/items", method: "patch" }); // seam: call PATCH /items
