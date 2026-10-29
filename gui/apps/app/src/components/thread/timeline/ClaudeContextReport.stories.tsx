import {
  ClaudeContextReportCard,
  parseClaudeContextReport,
} from "./ClaudeContextReport";

export default { title: "thread/timeline/Claude context report" };

// Real `/context` output shape from Claude Code 2.1.291 (trimmed skill list).
const SAMPLE = `## Context Usage

**Model:** claude-opus-5-5[1m]
**Tokens:** 186.2k / 1m (19%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.5k | 0.3% |
| System tools | 14.6k | 1.5% |
| MCP server instructions | 717 | 0.1% |
| MCP tools (deferred) | 1.5k | 0.2% |
| System tools (deferred) | 19.9k | 2.0% |
| Memory files | 7.4k | 0.7% |
| Skills | 9.9k | 1.0% |
| Messages | 151.1k | 15.1% |
| Free space | 780.8k | 78.1% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__codex-cu__js | codex-cu | 1.3k |
| mcp__codex-cu__js_reset | codex-cu | 188 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| AutoMem | /Users/you/.claude/projects/-Users-you-code-app/memory/MEMORY.md | 2.6k |
| Project | /Users/you/code/AGENTS.md | 2.1k |
| Project | /Users/you/code/app/AGENTS.md | 2.7k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| adr-verbatim | User | ~70 |
| deepapi | User | ~170 |
| supabase | User | ~270 |
| supabase-postgres-best-practices | User | ~290 |
| dataviz | Built-in | ~480 |
| claude-api | Built-in | ~360 |
`;

export function Default() {
  const report = parseClaudeContextReport(SAMPLE);
  return (
    <div className="max-w-3xl p-6 text-sm">
      {report ? <ClaudeContextReportCard report={report} /> : "Parse failed"}
    </div>
  );
}
