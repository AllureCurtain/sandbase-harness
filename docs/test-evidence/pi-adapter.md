# Pi stdout adapter evidence

Verification date: 2026-09-15. The adapter fixture suite is deterministic and does
not require a model credential or a Pi installation.

## Pinned contract

- Fixture manifest: `tests/fixtures/pi/v0.84.4/manifest.json`
- Pi CLI reference version: `0.84.4` (synthetic contract fixtures, not a live
  provider capture)
- Protocol input: LF-delimited Pi print/JSON events
- Authority: SandBase SQLite `EventLogger`; Pi `--session` JSONL is not replayed
  as CMA history

## Covered invariants

- Byte-safe incremental LF framing with a 16 MiB line/buffer limit; no
  `readline`.
- Invalid UTF-8 and malformed authority-bearing JSON fail the turn. Unknown
  valid event types are inert and cannot create tools or approval authority.
- Text deltas are transient (`seq: 0`); final assistant text is appended before
  broadcast and is the durable replay source.
- Native Pi tool use/result is visible as trajectory only. No Harness
  `requires_confirmation`, `ToolResolver`, path-confinement, or Allow/Deny
  authority is attached.
- Structured Pi markup is filtered across chunk boundaries.
- stderr is retained only as a redacted 64 KiB tail and never drives event
  translation.
- Each Pi model request records usage once even when message and turn events
  both carry usage.
- Nonzero exit and protocol failures are observable through the session error
  path; successful completion appends `turn_complete` after prior durable
  events.

## Commands

```text
npm run typecheck:src
npm run typecheck:tests
npm test -- tests/unit/pi-jsonl-reader.test.ts tests/unit/pi-markup.test.ts tests/unit/pi-translator.test.ts tests/unit/pi-strategy-adapter.test.ts tests/unit/pi-fixtures.test.ts
```

The fixture suite is synthetic. Real Pi trust/AGENTS.md/skills behavior,
three-turn session-file continuity, provider usage, and native process cleanup
require the separately pinned conformance and continuity walkthrough; they must
not be inferred from this fixture-only evidence.
