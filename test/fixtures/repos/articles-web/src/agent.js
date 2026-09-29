const API_ROOT = "https://conduit.example.com/api";
export const get = (slug) => requests.get(`/articles/${slug}`);
export const raw = (url) => superagent.get(`${API_ROOT}${url}`);
