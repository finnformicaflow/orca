// How a stored tool step reads in the chat. The bridge records a call as it came in — id, name, the
// whole input — and never a label, so what a tool LOOKS like is decided here, at render time: a new
// tool renders without touching the database, and the same row can be relabelled later. Pure.
import type { AgentStep } from "../../shared/agent";

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The one-line summary a tool call shows collapsed: `Running: bun test`, `Editing foo.ts`. Covers
 *  Claude's tools, Codex's item types, and Cursor's `*ToolCall` names; anything unknown falls back to
 *  the tool name plus whatever looks like its subject. */
export function toolLabel(step: AgentStep): string {
  if (step.text) return step.text; // rows written before content parts carried a pre-rendered label
  const i = (step.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : undefined);
  const file = (s("file_path") ?? s("path") ?? s("filePath"))?.split("/").pop();
  const command = s("command");
  const query = s("query") ?? s("pattern");
  switch (step.name) {
    case "Read": case "readFile": return file ? `Reading ${file}` : "Reading a file";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": case "file_change": case "editFile": case "writeFile":
      return file ? `Editing ${file}` : "Editing a file";
    case "Bash": case "command_execution": case "shell": return command ? `Running: ${oneLine(command, 120)}` : "Running a command";
    case "Grep": return query ? `Searching for ${oneLine(query, 60)}` : "Searching";
    case "Glob": return "Finding files";
    case "Task": return "Delegating to a subagent";
    case "WebFetch": case "WebSearch": case "web_search": return `Searching the web${query ? `: ${oneLine(query, 60)}` : ""}`;
    case "mcp_tool_call": return `Using ${s("tool") ?? "an MCP tool"}`;
    default: {
      const subject = command ?? file ?? query;
      return subject ? `${step.name}: ${oneLine(subject, 120)}` : `Using ${step.name ?? "a tool"}`;
    }
  }
}

/** The call's full input for the expanded view. A command reads best bare; anything else as JSON, so
 *  an Edit's old/new strings or an MCP call's arguments are all there — that's what the row stores. */
export function toolDetail(step: AgentStep): string | undefined {
  if (step.detail) return step.detail; // rows written before `input` was kept
  if (step.input === undefined || step.input === null) return undefined;
  if (typeof step.input === "string") return step.input;
  const i = step.input as Record<string, unknown>;
  const keys = Object.keys(i);
  if (keys.length === 1 && typeof i[keys[0]!] === "string") return i[keys[0]!] as string;
  return keys.length ? JSON.stringify(i, null, 2) : undefined;
}
