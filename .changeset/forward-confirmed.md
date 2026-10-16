---
"inistate-mcp": patch
---

`submit_activity` passes `confirmed: true` on to the platform. The platform checks
the approval itself for the `comment` standard (hybrid actor) and for an App
module's hybrid-tier email recipients, so an approved comment no longer comes
back `hybrid_requires_confirmation` however often it is resubmitted (SS06044).
