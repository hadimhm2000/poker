-- Host corrections: taking chips off a player's stack (a too-large rebuy, or chips
-- removed mid-game). Recorded in the game's event log with its own type so it never
-- counts as a rebuy in stats, stories or the export.

ALTER TYPE game_event_type ADD VALUE IF NOT EXISTS 'deduct';
