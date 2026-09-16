---
"inistate-mcp": patch
---

OAuth code exchange no longer falls back to a login-JWT session when the connection mint fails for an availability reason (a 5xx, an unexpected status, an unusable body, or no answer at all). Such a session bypasses the Connections seat gate, which the backend deliberately never enforces on login tokens (SS06119). The exchange now answers `temporarily_unavailable` and the connector retries; the JWT fallback remains only for the explicit "Connections is off" answer (404).
