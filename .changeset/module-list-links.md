---
"inistate-mcp": patch
---

`set_workspace` and `list_workspaces` now pass each module's `description` and `links` (the modules its fields link to) through to the agent when the API sends them, and add one hint line saying what they are for. Look-alike modules (an AR deposit and an AP deposit, a goods return and a purchase return) are told apart by what they link to: in a benchmark, Claude Haiku 4.5 filed the wrong look-alike in 4 of 27 runs from bare names and in 1 of 27 with links listed. Against an API that does not send the fields, the output is unchanged. The API side is proposed in FETIAS `docs/mcp-module-list-links-proposal.md`.
