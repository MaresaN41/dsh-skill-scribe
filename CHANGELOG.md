# Changelog

## 0.1.0 — 2026-11-05

- Draft reusable skill proposals from eligible completed dsh turns.
- Prefer the dsh model route, with optional OpenAI-compatible endpoint configuration.
- Store proposals separately for human review and provide list, show, diff, accept, and reject commands.
- Redact recognized secret patterns before sending draft input and before writing proposal content; redaction is not guaranteed to catch every sensitive value.
- Include a session-log example for drafting proposals from recorded turns.
