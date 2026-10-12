import { parseEndpoint, type Endpoint } from "./http.js";
import type { SeamFamily } from "./seams.js";

/** Families whose seams are matched by name rather than by method and path. */
export type NamedFamily = Exclude<SeamFamily, "http">;

/**
 * The key two repos agree on for an event, gRPC method or package name, or null when the name
 * can't be one. Case never matters. An event or topic name is kept whole (dots in a topic mean
 * something). A gRPC method is `Service/Method`, without the proto package, since clients rarely
 * spell it. A package loses its version (`@citation/ui@^2.1`, `requests==2.31`).
 */
export function normaliseName(family: NamedFamily, raw: string): string | null {
  const name = raw.trim();
  if (family === "event") return name ? name.toLowerCase() : null;
  if (family === "grpc") {
    const parts = name.replace(/^\//, "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0].split(".").at(-1)}/${parts[1]}`.toLowerCase();
  }
  return withoutVersion(name).toLowerCase() || null;
}

/** `@citation/ui@^2.1` → `@citation/ui`, `requests==2.31` → `requests`. */
export function withoutVersion(raw: string): string {
  let name = raw.trim().split(/\s+/)[0] ?? "";
  const version = name.indexOf("@", 1);
  if (version > 0) name = name.slice(0, version);
  return name.split(/[=<>!~^;[]/)[0] ?? "";
}

/** What `brain_find_consumers` was asked about: an HTTP endpoint, or a named event, gRPC method or package. */
export type LinkTarget = { family: "http"; endpoint: Endpoint } | { family: NamedFamily; name: string; key: string };

const WORDS: Record<string, NamedFamily> = { event: "event", topic: "event", queue: "event", message: "event", grpc: "grpc", package: "package" };

/**
 * Accepts `event OrderStarted` (or topic, queue, message), `grpc Basket/GetBasket`, `package
 * @citation/ui`, or anything `parseEndpoint` takes. Null when it is none of them.
 */
export function parseTarget(text: string, method?: string): LinkTarget | null {
  const named = text.trim().match(/^(\w+)\s+(.+)$/);
  const family = named ? WORDS[named[1]!.toLowerCase()] : undefined;
  if (family) {
    const name = named![2]!.trim();
    const key = normaliseName(family, name);
    return key ? { family, name, key } : null;
  }
  const endpoint = parseEndpoint(text, method);
  return endpoint ? { family: "http", endpoint } : null;
}
