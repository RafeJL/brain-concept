// Runs a TypeScript entry point from any working directory: tsx is resolved relative to this
// file, not the caller's folder. Also hides node:sqlite's one-line ExperimentalWarning.
import { register } from "tsx/esm/api";

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return emitWarning.call(process, warning, ...rest);
};

register();

export function launch(entry) {
  return import(new URL(entry, import.meta.url).href);
}
