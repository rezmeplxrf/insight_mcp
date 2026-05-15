# Insight MCP Agent Instructions

This package is both a CLI and an MCP server. Default to a user-friendly product mindset: the tool should help users complete the task with the least friction, not punish small mistakes. This is public repository. Don't store any sensitive info or rely on out-of-scope files.

## UX Principles

- Prefer forgiving behavior over failure when the user intent is clear and ignoring or re-prompting is safe.
- In interactive CLI mode, re-prompt for missing or invalid input when possible instead of exiting.
- In non-interactive mode, fail only when continuing would be ambiguous, destructive, or likely to produce incorrect results.
- Error messages must be actionable and specific: name the bad option, say what is accepted, and avoid generic validation dumps.
- Do not add hostile validation just because an input is technically unsupported. If a value can be safely ignored without changing the requested operation, ignore it.
- Do not silently change behavior in a way that could surprise scripts. If output shape changes, add tests and make the message clear.

## Interactive CLI Rules

- Prompts must include a concise parameter description before the input instruction.
- The input instruction must clearly show required/optional status, allowed choices, defaults, and when Enter skips.
- Avoid duplicated prompt text. Do not repeat enum values in both the label and the choices metadata.
- Conditionally required inputs should be conditionally prompted. Do not display "conditionally required" as a burden on the user.
- If an invalid value is entered, explain the problem and re-prompt within the existing attempt limit.
- Prompt only for parameters that apply to the selected tool and earlier answers.
- Storage prompts must be clear about whether the original API response is stored and which formats are available.
- `download_history` does not support `--filter`; do not show or prompt for it there. If a user passes `--filter` to `download_history`, ignore it rather than failing.

## Filter And Storage Behavior

- API tools support `--filter` with JSONata. `download_history` does not.
- In interactive mode, prompt for `--filter` at the end for API tools, with Enter meaning no filter.
- Validate JSONata syntax before making the API request when possible.
- If a filter returns empty data, return the filtered value plus a clear message showing where the original response was stored.
- If storage was requested, point the empty-filter message at the requested storage path.
- If storage was not requested, store the original response under `./.tmp/insight` for empty filtered results.

## MCP Rules

- MCP tool schemas and descriptions should match CLI behavior.
- Keep schema descriptions concise, practical, and user-facing.
- If CLI and MCP share behavior, implement it in shared production code and test that shared path.
- MCP failures should be useful to the caller: include the cause and the exact parameter to fix.

## Tests And Verification

- Add tests for UX behavior, especially interactive prompts, re-prompts, ignored safe inputs, and non-interactive errors.
- Prefer tests that exercise production CLI/MCP paths instead of asserting implementation details.
- Run `npm test`, `npm run typecheck`, and `npm run lint` after behavior changes.
- For documentation-only changes, run at least `npm run lint`.
