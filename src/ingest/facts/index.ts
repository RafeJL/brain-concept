import { codeowners } from "./codeowners.js";
import { dotnet } from "./dotnet.js";
import { lockfile } from "./lockfile.js";
import { packageJson } from "./package-json.js";
import type { FactReader } from "./reader.js";
import { readme } from "./readme.js";

export const READERS: readonly FactReader[] = [packageJson, lockfile, dotnet, codeowners, readme];
