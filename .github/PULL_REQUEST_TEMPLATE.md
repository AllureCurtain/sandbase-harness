<!--
One PR, one independently verifiable behavior.
See CONTRIBUTING.md#one-pr-one-verifiable-behavior.

Write the four sections below as prose, not checkboxes. The point is evidence a
reviewer can check, not a list a reviewer has to trust.
-->

## What changed

<!--
The user-visible or client-visible behavior after this PR, and the focused
change that produces it. Lead with the observable outcome.
-->

## Constraints and invariants

<!--
What holds after this change: lifecycle ordering, idempotency, ownership
boundaries, one-shot authority, append-only guarantees, limits and deadlines.
Note whether the public /v1 protocol, the database schema, or the published
package surface changed.
-->

## Out of scope

<!--
What this PR deliberately does not do, and which follow-up carries it. Also
note anything deferred from review with the reason.
-->

## Validation

<!--
Report what actually ran, not what should have run:

- the suites and commands executed, and their results;
- the regression test that failed before the fix and passes after it;
- manual scenarios walked in a real run, when the change is user-visible in the
  Console (see CONTRIBUTING.md#behavior-that-automated-checks-cannot-cover);
- every check that could not run or intentionally skipped, and the exact
  blocker or unavailable dependency;
- the review method used, stated honestly.

Confirm before opening:

- Documentation, migrations, and CHANGELOG were updated when public behavior
  changed.
- No secrets, credentials, personal paths, or host tokens are included.
- `tsconfig.tests.json` continues to type-check all test suites, including
  Console-importing tests.
-->
