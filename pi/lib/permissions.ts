export interface PermissionPolicy {
  enabled: boolean;
  allow: string[];
}

export function parsePolicy(raw: string): PermissionPolicy {
  const value = JSON.parse(raw);
  if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.allow) ||
      !value.allow.every((item: unknown) => typeof item === "string")) {
    throw new Error("Expected {enabled: boolean, allow: string[]}");
  }
  return { enabled: value.enabled, allow: value.allow };
}

export function classifyCommand(command: string): "GREEN" | "YELLOW" | "RED" {
  // Deliberately do not parse shell syntax into supposedly safe fragments.
  // Quotes, substitutions, operators, escapes, assignments, comments, and
  // multiline commands can change execution and are never auto-allowed.
  if (/[\n\r;&|<>`$\\'"(){}#=*?!\[\]~]/.test(command)) return "RED";
  const words = command.trim().split(/\s+/);
  const executable = words[0].split("/").at(-1) ?? "";
  if (/^(?:bash|sh|zsh|fish|python\d*(?:\.\d+)?|ruby|node|perl|npm|npx|uv|bundle|bundler|pip\d*|pipx|bunx?|deno|mise|sudo|su|rm|curl|wget|ssh|scp|env|eval|exec|source|chmod|chown|aws|gcloud|az|kubectl|docker)$/.test(executable)) return "RED";
  if (command === "pwd") return "GREEN";
  if (words[0] === "git" && words[1] === "status" &&
      words.slice(2).every((arg) => ["--short", "--branch", "--porcelain"].includes(arg))) return "GREEN";
  if (words.length === 3 && words[0] === "git" && words[1] === "diff" &&
      ["--stat", "--name-only"].includes(words[2])) return "GREEN";
  return "YELLOW";
}

export function autoAllowed(policy: PermissionPolicy, command: string): boolean {
  return classifyCommand(command) === "GREEN" && policy.allow.includes(command);
}
