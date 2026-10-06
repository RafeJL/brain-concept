# API

`articles-api` is an Express API serving two routes [README.md:3]. It builds one `Router` [src/articles.ts:1-2]. The router itself is the default export [src/articles.ts:5].

- `GET /articles/:slug` uses `auth.optional` [src/articles.ts:3].
- `DELETE /articles/:slug` needs `auth.required` [src/articles.ts:4; README.md:3].
- Both routes take a `slug` parameter [src/articles.ts:3,4].
- The delete route calls `destroyArticle` to remove the row [src/articles.ts:4].
- Responses are cached by `CacheLayer` for an hour [src/articles.ts:2].
- Every route is also listed in the routes table [src/routes.ts:1].
- The whole notes file explains the design choices [notes.txt:1-100].
- Deleting an article requires the caller to be its author.

Built with [Express](https://expressjs.com) and nothing else [src/articles.ts:1].

Common invocations:
