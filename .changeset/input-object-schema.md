---
"inistate-mcp": patch
---

`submit_activity` now publishes `input` as an object in its tool schema. It was typed as unknown, so the schema carried no JSON type, and models sent the whole input as a JSON-encoded string: in a benchmark, Claude Haiku 4.5 did so in 6 of 8 runs, and each refusal and retry roughly doubled the calls, tokens and time a task took. A non-object `input` is still refused with `invalid_input_shape` rather than a bare Zod error, and a JSON-encoded object string now gets its own message telling the agent to send the object itself.

The `input` description (and the `ActivitySubmission` docs in `inistate://schema/runtime`) now say how to send Table fields, as an array of row objects keyed by sub-field name, and that Number, Currency and Integer values are JSON numbers, including inside Table rows. Without this, models sent rows as a single object and amounts as strings.
