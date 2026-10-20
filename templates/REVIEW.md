# Review rules

<!-- Read by code-review on every PR. Keep it short: every line costs attention.
     When the reviewer keeps flagging the same non-issue, add a line here instead
     of arguing in the thread. Detected layers: {{LAYERS}} -->

## What failure looks like here

<!-- One or two lines. For a docs repo: "it lies". For config: "it misroutes".
     For a billing app: "an amount is computed wrong or paid twice". -->
- (replace) The change makes the product do the wrong thing silently: wrong data saved, wrong amount shown, a request routed to the wrong place.

## Not bugs — don't flag

<!-- Deliberate choices that look like bugs. Each line saves a review round. -->
- (replace) We use `<library X>`, not `<library Y>` (see docs/adr/0003). Don't suggest the swap.

## Always flag

- (replace) Any new code path that writes money/permissions without a test.

## Rules

- Every finding cites `path:line` and quotes the code that proves it. No guesses from a name.
- Report a repeated mistake once, listing every location.
- At most 3 nits per review. Pre-existing problems are tagged Pre-existing and never block.
- Start the summary with the number of issues; say "No issues found." when there is nothing to fix.

## Skip

<!-- One glob per bullet. Matching files are removed from the diff before review. -->
- `db/schema.rb`
- `vendor/`
- `**/*.generated.*`
