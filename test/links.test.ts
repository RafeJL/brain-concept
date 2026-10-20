import { describe, expect, it } from "vitest";
import { verifySeams } from "../src/ai/seams.js";
import { normaliseName, parseTarget } from "../src/core/links.js";
import { LOCAL_CALLER, type AccessPolicy } from "../src/serve/access.js";
import { findConsumers } from "../src/serve/tools/find-consumers.js";
import { impact } from "../src/serve/tools/impact.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { search } from "../src/serve/tools/search.js";
import { fixtureWorld, makeRepo } from "./helpers.js";

/** Fixture repos enrolled under their own names, synced and mapped from their recorded answers, once for the file. */
const events = fixtureWorld(["ordering-events", "notify-worker"]);
const grpc = fixtureWorld(["basket-grpc", "basket-client"]);
const packages = fixtureWorld(["ui-kit", "ui-app"]);
const all = fixtureWorld(["ordering-events", "notify-worker", "basket-grpc", "basket-client", "ui-kit", "ui-app"]);

const named = (kind: string, name: string, cites: [string, number, number][], runtime = false) => ({
  kind,
  name,
  runtime,
  cites: cites.map(([file, start, end]) => ({ file, start, end })),
});

describe("names of events, gRPC methods and packages", () => {
  it("normalises them so two repos agree: case, the proto package and package versions don't matter", () => {
    expect(normaliseName("event", " OrderStartedIntegrationEvent ")).toBe("orderstartedintegrationevent");
    expect(normaliseName("event", "orders.started")).toBe("orders.started");
    expect(normaliseName("grpc", "BasketApi.Basket/GetBasket")).toBe("basket/getbasket");
    expect(normaliseName("grpc", "/Basket/GetBasket")).toBe("basket/getbasket");
    expect(normaliseName("grpc", "GetBasket")).toBeNull();
    expect(normaliseName("package", "@Citation/UI@^2.1.0")).toBe("@citation/ui");
    expect(normaliseName("package", "requests==2.31")).toBe("requests");
    expect(normaliseName("package", "Newtonsoft.Json 13.0.1")).toBe("newtonsoft.json");
  });

  it("parses what brain_find_consumers is asked for, and still takes HTTP endpoints", () => {
    expect(parseTarget("event OrderStarted")).toEqual({ family: "event", name: "OrderStarted", key: "orderstarted" });
    expect(parseTarget("topic orders.started")).toMatchObject({ family: "event", key: "orders.started" });
    expect(parseTarget("grpc Basket/GetBasket")).toMatchObject({ family: "grpc", key: "basket/getbasket" });
    expect(parseTarget("package @citation/ui@2.1.0")).toMatchObject({ family: "package", key: "@citation/ui" });
    expect(parseTarget("GET /api/orders/:id")).toEqual({ family: "http", endpoint: { method: "GET", key: "/api/orders/{}" } });
    expect(parseTarget("grpc GetBasket")).toBeNull();
  });
});

describe("verifying events, gRPC methods and packages", () => {
  const files = {
    "Publisher.cs": "await eventBus.PublishAsync(new OrderStartedIntegrationEvent(order.Id));\n",
    "BasketService.cs": ["public class BasketService : Basket.BasketBase", "{", "", "", "", "", "", "", "", "  public override Task<Reply> GetBasket(Request r, ServerCallContext c) => Done();", "}"].join("\n"),
    "package.json": '{\n  "name": "@citation/ui",\n  "version": "2.1.0"\n}\n',
    "worker.ts": "channel.consume(process.env.QUEUE!, handle);\n",
  };
  const verify = (...found: unknown[]) => verifySeams(found, makeRepo(files), "repo", "abc");

  it("keeps each kind when its name, or each part of it, is in the cited lines", () => {
    const { kept, dropped } = verify(
      named("event-publish", "OrderStartedIntegrationEvent", [["Publisher.cs", 1, 1]]),
      named("grpc-serve", "Basket/GetBasket", [["BasketService.cs", 10, 10], ["BasketService.cs", 1, 1]]),
      named("package-publish", "@citation/ui@2.1.0", [["package.json", 2, 2]]),
    );

    expect(dropped).toEqual([]);
    expect(kept.map((s) => [s.kind, s.method, s.rawPath, s.key, `${s.path}:${s.startLine}`])).toEqual([
      ["event-publish", "event", "OrderStartedIntegrationEvent", "orderstartedintegrationevent", "Publisher.cs:1"],
      ["grpc-serve", "grpc", "Basket/GetBasket", "basket/getbasket", "BasketService.cs:10"],
      ["package-publish", "package", "@citation/ui@2.1.0", "@citation/ui", "package.json:2"],
    ]);
    expect(kept[1]!.cites).toEqual([{ path: "BasketService.cs", start: 1, end: 1 }]);
  });

  it("drops what the cited lines don't support, and says why", () => {
    const { kept, dropped } = verify(
      named("event-publish", "OrderPaidIntegrationEvent", [["Publisher.cs", 1, 1]]),
      named("grpc-serve", "Ordering/GetBasket", [["BasketService.cs", 10, 10]]),
      named("grpc-call", "GetBasket", [["BasketService.cs", 10, 10]]),
      named("package-publish", "@citation/ui", [["package.json", 9, 9]]),
      named("grpc-serve", "Basket/GetBasket", [["BasketService.cs", 10, 10]], true),
      { kind: "event-publish", runtime: false, cites: [{ file: "Publisher.cs", start: 1, end: 1 }] },
    );

    expect(kept).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      '"OrderPaidIntegrationEvent" isn\'t in the cited lines',
      '"Ordering" isn\'t in the cited lines',
      '"GetBasket" isn\'t a gRPC Service/Method',
      "cites package.json:9-9, outside the file (5 lines)",
      "a grpc-serve's name must be known",
      "malformed entry",
    ]);
    expect(dropped[0]!.seam).toBe("event-publish OrderPaidIntegrationEvent (Publisher.cs:1)");
  });

  it("keeps a name only known at run time with no key, at its call site", () => {
    const { kept } = verify(named("event-subscribe", "process.env.QUEUE", [["worker.ts", 1, 1]], true));

    expect(kept.map((s) => [s.kind, s.rawPath, s.key, s.startLine])).toEqual([["event-subscribe", "process.env.QUEUE", null, 1]]);
  });
});

describe("events across repos", () => {
  it("finds the publisher and the handlers, the publisher's own handler marked same repo", async () => {
    const { deps } = events();

    const started = await findConsumers(deps, LOCAL_CALLER, { target: "event OrderStartedIntegrationEvent", format: "concise" });
    const changed = await findConsumers(deps, LOCAL_CALLER, { target: "event orderstatuschangedintegrationevent", format: "concise" });

    expect(started.text).toContain("event OrderStartedIntegrationEvent · 1 publisher, 1 handler in 2 repos · llm-generated");
    expect(started.text).toContain(
      "Published by\n  ordering-events · src/OrderingService.cs:5 · event OrderStartedIntegrationEvent\n\nHandled by\n  notify-worker · src/consumer.ts:2 · event OrderStartedIntegrationEvent",
    );
    expect(started.text).toContain("1 event link uses a name only known at run time (notify-worker · src/consumer.ts:3)");
    expect(changed.text).toContain("Handled by\n  ordering-events · src/OrderStatusChangedHandler.cs:1-3 · event OrderStatusChangedIntegrationEvent · same repo");
  });

  it("matches names exactly, and suggests the known names when nothing matches", async () => {
    const { deps } = events();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "event OrderStarted", format: "concise" });

    expect(result.text).toContain("No publishers or handlers found for event OrderStarted.");
    expect(result.text).toContain('Known event names containing "OrderStarted": OrderStartedIntegrationEvent.');
  });

  it("lists what a publishing file provides and who handles it", async () => {
    const { deps } = events();

    const result = await impact(deps, LOCAL_CALLER, { repo: "ordering-events", path: "src/OrderingService.cs", format: "concise" });

    expect(result.text).toContain("ordering-events · src/OrderingService.cs · 2 events published, 2 callers in 2 repos · llm-generated");
    expect(result.text).toContain("event OrderStartedIntegrationEvent  (5)\n  ← notify-worker · src/consumer.ts:2");
    expect(result.text).toContain("event OrderStatusChangedIntegrationEvent  (10)\n  ← ordering-events · src/OrderStatusChangedHandler.cs:1-3 · same repo");
  });

  it("never shows a handler or publisher in a repo the caller can't read", async () => {
    const { store } = events();
    const onlyOrdering: AccessPolicy = { readableRepos: async () => new Set(["ordering-events"]) };
    const deps = { store, access: onlyOrdering };

    const consumers = await findConsumers(deps, LOCAL_CALLER, { target: "event OrderStartedIntegrationEvent", format: "concise" });
    const radius = await impact(deps, LOCAL_CALLER, { repo: "ordering-events", format: "concise" });
    const card = await repoCard(deps, LOCAL_CALLER, "ordering-events", "concise");

    for (const text of [consumers.text, radius.text, card.text]) expect(text).not.toContain("notify-worker");
    expect(consumers.text).toContain("1 publisher, 0 handlers in 1 repo");
  });
});

describe("gRPC and packages across repos", () => {
  it("finds the gRPC server and its client in another language", async () => {
    const { deps } = grpc();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "grpc BasketApi.Basket/GetBasket", format: "detailed" });

    expect(result.text).toContain("grpc BasketApi.Basket/GetBasket · 1 server, 1 caller in 2 repos");
    expect(result.text).toContain("Served by\n  basket-grpc · Services/BasketService.cs:3-4 · grpc Basket/GetBasket · exact · path built with Services/BasketService.cs:1");
    expect(result.text).toContain("Called by\n  basket-client · basket_client.py:7 · grpc Basket/GetBasket");
  });

  it("lists a gRPC service's methods with their callers", async () => {
    const { deps } = grpc();

    const result = await impact(deps, LOCAL_CALLER, { repo: "basket-grpc", format: "concise" });

    expect(result.text).toContain("basket-grpc · 2 gRPC methods, 1 caller in 1 repo");
    expect(result.text).toContain("grpc Basket/GetBasket  (Services/BasketService.cs:3-4)\n  ← basket-client · basket_client.py:7");
    expect(result.text).toContain("No known callers: grpc Basket/DeleteBasket");
  });

  it("finds the package and the repo that depends on it, whatever the version", async () => {
    const { deps } = packages();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "package @citation/ui@2.1.0", format: "concise" });
    const radius = await impact(deps, LOCAL_CALLER, { repo: "ui-kit", route: "package @citation/ui", format: "concise" });

    expect(result.text).toContain("1 publisher, 1 dependent in 2 repos");
    expect(result.text).toContain("Published by\n  ui-kit · package.json:2 · package @citation/ui\n\nUsed by\n  ui-app · package.json:5 · package @citation/ui");
    expect(radius.text).toContain("ui-kit · 1 package, 1 caller in 1 repo");
  });

  it("keeps HTTP and the other kinds apart", async () => {
    const { deps } = grpc();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "/GetBasket", format: "concise" });

    expect(result.text).toContain("No servers or callers found for any method /getbasket.");
  });
});

describe("cards and search", () => {
  it("count every kind in the seams line and in Calls / Called by", async () => {
    const { deps } = all();

    const ordering = await repoCard(deps, LOCAL_CALLER, "ordering-events", "concise");
    const worker = await repoCard(deps, LOCAL_CALLER, "notify-worker", "concise");
    const kit = await repoCard(deps, LOCAL_CALLER, "ui-kit", "concise");
    const client = await repoCard(deps, LOCAL_CALLER, "basket-client", "concise");

    expect(ordering.text).toContain("Seams: events: 2 published, 1 handled · llm-generated");
    expect(ordering.text).toContain("Called by: notify-worker (1 handler)");
    expect(worker.text).toContain("Seams: events: 1 handled (+1 run-time) · llm-generated");
    expect(worker.text).toContain("Calls: ordering-events (1 event)");
    expect(kit.text).toContain("Called by: ui-app (1 package use)");
    expect(client.ok && client.data.neighbours.calls).toEqual([{ repo: "basket-grpc", count: 0, suffix: false, links: { grpc: 1 } }]);
    expect(client.text).toContain("Calls: basket-grpc (1 gRPC method)");
    // Six repos synced and mapped: about 10s alone, twice that when the whole suite runs at once.
  }, 30_000);

  it("finds events by the words in their names", async () => {
    const { deps } = events();

    const result = await search(deps, LOCAL_CALLER, { query: "order started", format: "concise" });

    expect(result.text).toContain("event OrderStartedIntegrationEvent · ordering-events · src/OrderingService.cs:5 (event published)");
  });
});
