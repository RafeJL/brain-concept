#!/usr/bin/env node
import { launch } from "./launch.mjs";

await launch("../src/serve/mcp-stdio.ts");
