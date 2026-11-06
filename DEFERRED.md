# Deferred

One line per item that was noticed but is not a bug, blocker, security issue, design flaw or regression.

- `agents/constraints.txt` leaves `aiohttp-retry` (via kubernetes) and `tzdata` (via python-dateutil) unpinned. Both are in the resolved closure (seen 2026-11-06, #148). Pin them at the next container regeneration, as was done for `packaging`.
