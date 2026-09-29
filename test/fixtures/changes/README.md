# Fixture changes

Each folder is a set of files committed on top of a fixture repo (`commitFixture` in
`test/helpers.ts`), to test what a sync does when files change between commits.

| Change | Applied to | Does |
|---|---|---|
| `articles-api-v2` | `repos/articles-api` | Replaces the GET/DELETE routes in `src/articles.ts` with a PUT, and adds `src/tags.ts` |
