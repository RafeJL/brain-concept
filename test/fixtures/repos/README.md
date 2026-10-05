# Fixture repos

Each folder here becomes a throwaway git repo in integration tests (`repoFromFixture` in
`test/helpers.ts`), so sync, matching and the tools run against real files. Tests assert line
numbers in these files: keep existing lines where they are.

| Repo | Plays the part of |
|---|---|
| `articles-api` | An Express backend serving `GET` and `DELETE /articles/:slug` |
| `articles-web` | A frontend calling that API through a client with a base URL, plus one run-time URL |
| `orders-api` | An ASP.NET API: a controller, a minimal API, an OpenAPI spec and its own tests calling it |
| `shop-web` | A TS frontend calling `orders-api`, plus one run-time URL |
| `mixed-languages` | TypeScript, C#, Markdown and an unknown file type, for language detection |
| `status-api` | Serves `/` and `/status` |
| `status-checks` | Calls `/` and `/status`; only `/status` says which service it means |
