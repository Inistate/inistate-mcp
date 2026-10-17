---
"inistate-mcp": patch
---

`submit_activities` passes `confirmed` on to the platform, as `submit_activity`
does since SS06044. An approved bulk App send whose recipients need a person's
approval (a Notifications send to more than 10 members, a mail send to a
"hybrid" recipient list) was refused "Send needs confirmation" however often it
was resubmitted (SS06342; needs the matching FETIAS change).
