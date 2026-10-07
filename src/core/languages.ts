import { basename, extname } from "node:path";

const BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".cs": "C#", ".csproj": "MSBuild", ".sln": "MSBuild", ".props": "MSBuild", ".targets": "MSBuild",
  ".fs": "F#", ".vb": "Visual Basic",
  ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".scala": "Scala", ".groovy": "Groovy",
  ".py": "Python", ".rb": "Ruby", ".php": "PHP", ".go": "Go", ".rs": "Rust",
  ".swift": "Swift", ".m": "Objective-C", ".dart": "Dart",
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++",
  ".sql": "SQL", ".graphql": "GraphQL", ".gql": "GraphQL", ".proto": "Protocol Buffers",
  ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".less": "Less",
  ".vue": "Vue", ".svelte": "Svelte", ".razor": "Razor", ".cshtml": "Razor",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".xml": "XML",
  ".md": "Markdown", ".mdx": "Markdown",
  ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell", ".psm1": "PowerShell",
  ".tf": "Terraform", ".bicep": "Bicep",
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: "Dockerfile",
  Makefile: "Makefile",
  Jenkinsfile: "Groovy",
};

/** Best-effort language from a path. Null for unknown or binary files. */
export function detectLanguage(path: string): string | null {
  const name = basename(path);
  return BY_FILENAME[name] ?? BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}
