# Contributing

This optimization branch (`optimization/v1`) was developed by **Olympusxvn** with **Claude Code** (Claude Opus 4.6).

## Contributors

### Olympusxvn
- **Role:** Project lead, architect, code reviewer
- **GitHub:** [@Olympusxvn](https://github.com/Olympusxvn)
- **Responsibilities:**
  - Defined the optimization roadmap and requirements (`memwal_claude_code_prompt.txt`)
  - Reviewed all code changes and CI/CD pipeline outputs
  - Identified build failures and provided error logs for debugging
  - Made final decisions on architecture and implementation approach
  - Managed the fork, branch strategy, and PR workflow

### Claude Code (Claude Opus 4.6)
- **Role:** Implementation engineer, debugger
- **Tool:** [Claude Code](https://claude.com/claude-code) by Anthropic
- **Responsibilities:**
  - Implemented all code changes across Rust server, TypeScript SDK, and monorepo tooling
  - Debugged CI/CD failures iteratively (8 issues resolved across 11 commits)
  - Wrote CHANGELOG, lessons learned, and documentation
  - All commits co-authored: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

## Workflow

1. **Olympusxvn** wrote the optimization prompt with detailed step-by-step requirements
2. **Claude Code** implemented each step, committing incrementally
3. **CI/CD** ran on each push — failures were reported back by Olympusxvn
4. **Claude Code** diagnosed and fixed each failure (Rust borrow checker, clippy, Node.js deprecation, turbo scoping, React types mismatch, PATH issues)
5. **Olympusxvn** reviewed the final PR and documentation

## Branch

- **Branch:** `optimization/v1`
- **Base:** `dev`
- **PR:** [#1](https://github.com/Olympusxvn/MemWal/pull/1)

## Commits

| Commit | Description |
|--------|-------------|
| `18d886a` | feat: optimize server, SDK, and monorepo for performance and scalability |
| `4e3d7fc` | fix(ci): opt into Node.js 24 for actions, bump runtime to Node 22 LTS |
| `5d4515b` | fix: clone Arc\<AppState\> before move into router |
| `ccb1759` | fix: resolve all clippy warnings and dead-code errors |
| `c04abba` | docs: rewrite CHANGELOG with detailed descriptions and examples |
| `c772261` | fix(ci): remove explicit pnpm version, use packageManager from package.json |
| `10dd503` | fix(ci): scope TS build to SDK only |
| `d119d9f` | fix(ci): use turbo --filter to scope build to SDK only |
| `2135380` | fix(chatbot): upgrade @types/react to v19 to match react 19.0.1 |
| `630c35d` | docs: add lessons.md |
| `9bbaecb` | fix(ci): use pnpm exec turbo — turbo not in PATH in CI |
| `f7c7e9a` | docs: update CHANGELOG and lessons with latest fixes |
