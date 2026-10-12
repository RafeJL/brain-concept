/** "suggested" by Claude Code from the repos' cards and links; "confirmed" by a person. */
export type SystemStatus = "suggested" | "confirmed";

/** A group of repos that together make up one product, e.g. a front end and its APIs. */
export interface SystemRecord {
  name: string;
  /** One line on what the product is: from the suggestion, or a person's edit. */
  summary: string;
  /** Why Claude Code grouped these repos; empty for a system a person made. */
  reason: string;
  status: SystemStatus;
  suggestedAt: string | null;
  confirmedAt: string | null;
  /** Member repos, sorted. A repo belongs to at most one system. */
  repos: string[];
}
