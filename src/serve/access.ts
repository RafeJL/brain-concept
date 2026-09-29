/** Who is asking. Locally that is always the person running the MCP server. */
export interface Caller {
  id: string;
}

export const LOCAL_CALLER: Caller = { id: "local" };

/**
 * Decides which repos a caller may see. Every query asks this first and only reads rows from the
 * repos it returns, so permission checks live in one place. Hosted, this becomes a policy backed
 * by the caller's GitHub permissions.
 */
export interface AccessPolicy {
  readableRepos(caller: Caller, candidates: readonly string[]): Promise<ReadonlySet<string>>;
}

/** POC policy: whoever runs the brain locally can read every repo they enrolled. */
export class LocalAccessPolicy implements AccessPolicy {
  async readableRepos(_caller: Caller, candidates: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(candidates);
  }
}
