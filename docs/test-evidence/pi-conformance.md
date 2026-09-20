# Pi conformance evidence

Verification date: 2026-09-15. This record separates deterministic harness
proof from real-provider proof; a pinned CLI version alone is not evidence that
a model turn used the expected trust, skill, or resume behavior.

## Local observations

- `pi --version` on the Windows host returned `0.84.4`.
- The runtime invokes Pi through stdin and the controlled launcher tests verify
  multiline/Unicode input is not placed in argv.
- The launcher tests verify private `models.json` contains only
  `$SANDBASE_PI_API_KEY`, source API-key/base-URL names are not inherited, and
  the composed `AGENTS.md` is written in the managed work directory.
- Explicit skill directories are forwarded as one managed `--skill` argument
  per directory; `model_config.speed` maps to Pi `--thinking` (`fast`→`off`,
  `standard`→`medium`, `extended`→`high`).
- Three repeated controlled turns use one managed session file; a concurrent
  owner gets `pi_session_busy`, and a changed header/schema is rejected.

## Real Pi provider gate

The host had no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, or
`SANDBASE_PI_API_KEY` configured at verification time. Therefore a real
non-production model turn proving Pi project trust, `AGENTS.md` loading,
explicit `--skill` behavior, provider usage, and three-turn Pi resume was not
run. This is an external credential blocker, not a passing claim. The exact
next safe command, after a temporary non-production credential is supplied, is
to run the deterministic controlled test plus a fresh workspace walkthrough
with Pi `0.84.4`, then record only redacted observations here.

No credentials, personal paths, or provider diagnostics are stored in this
repository.
