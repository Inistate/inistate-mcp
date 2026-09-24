---
"inistate-mcp": patch
---

Three write paths discarded malformed input and reported success. Each is now refused instead, with a
structured error naming what was wrong:

- `submit_activity` coerced a non-object `input` to nothing, so a string or array of field values was
  dropped and the activity submitted with no fields at all — on create, an empty entry. `null` is still
  accepted as "no fields"; anything else is refused before it reaches the platform.
- `submit_activities` filtered malformed items out of the batch, so a hundred items could submit
  eighty-eight and answer success with no way to learn which twelve never happened. A bad item now
  fails the call and names its index.
- `update_module` forwarded an empty `information`, `states` or `activities` array. Those replace the
  section entirely, so an empty one deleted every field, state or activity on the module and reported a
  successful update. Omitting a section leaves it untouched, which is what an agent that computed
  nothing actually wants. `flows: []` is still allowed — a module with no transitions can be meant.
