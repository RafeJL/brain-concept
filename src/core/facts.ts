/**
 * A plain fact a repo states about itself in a well-known file: a script in package.json, a
 * .NET project's kind, a CODEOWNERS rule, the README's opening paragraph. Read by parsers,
 * never inferred, and replaced whenever the file changes.
 */
export type FactKind =
  /** package.json `name`. */
  | "package"
  /** A package.json script: name → command. */
  | "script"
  /** A lockfile: value is npm, pnpm, yarn or bun. */
  | "package-manager"
  /** A .sln or .slnx file. */
  | "dotnet-solution"
  /** A .csproj: name is the project, value its kind (see DotnetProjectKind). */
  | "dotnet-project"
  /** A CODEOWNERS rule: name is the pattern, value the owners separated by spaces. */
  | "owners"
  /** The README's first real paragraph. */
  | "summary";

export type DotnetProjectKind = "test" | "web" | "app" | "library";

/** What a reader finds in one file, before the sync knows the repo and commit. */
export interface FactDraft {
  kind: FactKind;
  name: string;
  value: string;
  /** 1-based line the fact is declared on, when it has one. */
  line: number | null;
}

export interface Fact extends FactDraft {
  repo: string;
  path: string;
  commit: string;
}
