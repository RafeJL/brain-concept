import { describe, expect, it } from "vitest";
import { joinPaths, matchKeys, methodFromVerb, normalisePath } from "../src/core/http.js";

describe("normalisePath", () => {
  it.each([
    ["/articles/:slug", "/articles/{}"],
    ["/articles/{slug}", "/articles/{}"],
    ["/articles/{id:int}/", "/articles/{}"],
    ["/files/{*rest}", "/files/{}"],
    ["https://conduit.example.com/api/Articles?limit=10#top", "/api/articles"],
    ["api/users", "/api/users"],
    ["//double//slashes/", "/double/slashes"],
    ["/v{version}/items", "/{}/items"],
    ["/", "/"],
    ["/api/catalog/items/42", "/api/catalog/items/{}"],
    ["/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301/lines", "/orders/{}/lines"],
    ["/v2/items", "/v2/items"],
  ])("%s → %s", (raw, key) => {
    expect(normalisePath(raw)).toBe(key);
  });
});

describe("matchKeys", () => {
  it("matches identical keys exactly", () => {
    expect(matchKeys("/articles/{}", "/articles/{}")).toBe("exact");
  });

  it("matches across an unknown base path at a segment boundary", () => {
    expect(matchKeys("/api/articles/{}", "/articles/{}")).toBe("suffix");
    expect(matchKeys("/articles/{}", "/api/articles/{}")).toBe("suffix");
    expect(matchKeys("/api/xarticles/{}", "/articles/{}")).toBeNull();
  });

  it("never lets a parameter-only key match everything", () => {
    expect(matchKeys("/api/{}", "/{}")).toBeNull();
  });

  it("does not treat a parameter as a wildcard for a literal", () => {
    expect(matchKeys("/articles/feed", "/articles/{}")).toBeNull();
  });
});

describe("helpers", () => {
  it("maps verbs to methods", () => {
    expect(methodFromVerb("del")).toBe("DELETE");
    expect(methodFromVerb("all")).toBe("*");
    expect(methodFromVerb("use")).toBeNull();
  });

  it("joins prefixes without doubling slashes", () => {
    expect(joinPaths("/api/", "/users")).toBe("/api/users");
    expect(joinPaths("", "users")).toBe("/users");
    expect(joinPaths("cats", "")).toBe("/cats");
  });
});
