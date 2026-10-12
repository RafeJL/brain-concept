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
| `ordering-events` | A C# service publishing two integration events through an event bus, and handling one of them itself |
| `notify-worker` | A TS worker handling `OrderStartedIntegrationEvent` from a queue, plus one queue named at run time |
| `basket-grpc` | A C# gRPC server: a `.proto` and the service implementing `Basket/GetBasket` and `Basket/DeleteBasket` |
| `basket-client` | A Python client calling `Basket/GetBasket` through a generated stub |
| `ui-kit` | A package whose `package.json` publishes `@citation/ui` |
| `ui-app` | A repo depending on `@citation/ui` (and on `react`, a public package that isn't listed) |

Each repo that has routes, calls or other links also has a recorded Claude Code answer in
`test/fixtures/seams/<repo>.json` (`mapSeams` in `test/helpers.ts`). Its citations are verified
against these files, so keep the line numbers in both in step.
