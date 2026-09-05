-- Defense in depth: pre-existing vehicles must never be purged because a later parking flow was abandoned.
-- Cleanup now requires a cancelled PARK session with vehicle_created_by_session=true at candidate, claim, and delete stages.

