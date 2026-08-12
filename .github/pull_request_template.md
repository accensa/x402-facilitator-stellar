## What changed

<!-- One or two sentences. What does this do that the tree did not do before? -->

## Why

<!-- The problem, not the patch. If it fixes an issue, link it: Closes #N -->

## How it was verified

<!-- Commands run and their result. "npm test passes" is fine; "should work" is not. -->

- [ ] `npm test`
- [ ] `npx eslint .`
- [ ] `npx prettier --check .`

## Wire format

Does this change anything a client can observe — a route, a status code, a
field name, a reason code, or the shape of a response?

- [ ] No
- [ ] Yes, and it is described below

<!--
Conformance here is judged at the wire level: reviewers point stock SDK code at
the service rather than read a claim. A field renamed by accident is a
conformance failure that passes every local test, so it needs saying out loud.
-->

## Anything a reviewer should push back on

<!-- Shortcuts taken, assumptions made, things you were unsure about. -->
