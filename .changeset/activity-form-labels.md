---
"inistate-mcp": patch
---

A field an activity's form relabels can now be addressed by the name the user sees (SS06181). The designer can give a field a different label on one activity's form; the web shows that label, but `get_form` listed only the field's own name, so "update the Text field" matched nothing. `get_form` now carries `label` on such a field (from the platform, FETIAS r33682), and `submit_activity` / `submit_activities` accept the label as an input key: it is mapped to the field it relabels and reported in `input_key_notes`. Exact field names still win, a label two fields share is never used, and a key that is a label for one field and a near-miss of another is refused as unknown. The activity's form is fetched only when an input key is not an exact field name.
