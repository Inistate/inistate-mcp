---
"inistate-mcp": patch
---

`submit_activity` / `submit_activities` now reject a YesNo field sent as anything but a boolean (e.g. the string `"yes"`) and a Text, MultilineText or Email field sent as anything but a string (e.g. an array of lines), with an `invalid_field_value_type` error that names the field and the correction. The platform stored such values verbatim: YesNo filters stopped matching and the mobile app could not open the entry for editing (SS06108, SS06110). `null` and `""` still clear a field, and the `input` description documents both rules.
