import type { DotnetProjectKind } from "../../core/facts.js";
import { fileName, isRepoOwn, lineMatching, type FactReader } from "./reader.js";

/** Packages and SDKs that make a project a test project wherever its settings live. */
const TEST_PACKAGES = /^(Microsoft\.NET\.Test\.Sdk|xunit|xunit\.v3|NUnit|MSTest|MSTest\.TestFramework|TUnit)$/i;
const TEST_SDKS = /^(MSTest\.Sdk)(\/|$)/i;
/** `Orders.Tests`, `Orders.UnitTests`, `Orders.FunctionalTests`, `Orders.Test`: the usual naming. */
const TEST_NAME = /\.(?:[A-Z]\w*)?Tests?$/;

/** .NET solutions (path only) and projects (what kind each is). */
export const dotnet: FactReader = {
  name: "dotnet",
  wants: (path) => /\.(sln|slnx|csproj)$/i.test(path) && isRepoOwn(path),
  needsContent: true,
  read(path, text) {
    const name = fileName(path).replace(/\.\w+$/, "");
    if (!/\.csproj$/i.test(path)) return [{ kind: "dotnet-solution", name, value: fileName(path), line: null }];
    if (!/<Project[\s>]/.test(text)) return [];
    return [{ kind: "dotnet-project", name, value: projectKind(name, text), line: lineMatching(text, /<Project[\s>]/) }];
  },
};

function projectKind(name: string, xml: string): DotnetProjectKind {
  const sdk = /<Project\s[^>]*\bSdk\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? "";
  const packages = [...xml.matchAll(/<PackageReference\s[^>]*\bInclude\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  const isTest =
    /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(xml) ||
    TEST_SDKS.test(sdk) ||
    packages.some((p) => TEST_PACKAGES.test(p)) ||
    TEST_NAME.test(name);
  if (isTest) return "test";
  if (/^Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly)\b/i.test(sdk)) return "web";
  if (/<OutputType>\s*(Win)?Exe\s*<\/OutputType>/i.test(xml)) return "app";
  return "library";
}
