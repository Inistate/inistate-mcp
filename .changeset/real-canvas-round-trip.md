---
"inistate-mcp": patch
---

Real module canvases can be updated again. Three checks rejected or rewrote shapes the platform itself
writes, so a module read with `get_module_canvas` could not be sent back with `update_module`:

- A flow with no `to` is legal — it means the activity runs without moving the record — and so is an
  absent or empty `from`, meaning it can run from any state. The platform stores flows that way and
  reads them back that way; only `activity` is genuinely required. A state that is *named* but does not
  exist is still an error.
- An activity may reference something that is not an information field (a layout element, a label), and
  the canvas read does not return those. On an update that is now a warning rather than an error: the
  server was rejecting its own read. On create it stays an error, because there a made-up field name is
  a mistake worth stopping.
- State colours are no longer snapped to the eight-colour palette on write. Only a value the platform
  cannot store — a colour name like "gray", or something that is not a colour — is mapped; any
  parseable hex is kept exactly as sent. The palette remains a suggestion on create.
