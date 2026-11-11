-- Migration 010: Assign password ('123456') to primary workspace owner account (48244777-c7a4-4e30-be4b-fe1104e443b8)
-- without removing the account or modifying its workspace assignments.

UPDATE users
SET password = '7b891a99843908468b88068490e58410:928b9db4adbf7089bbc754d9c1973e8b507f1d3b5ddf7ad45b2d4eae7d135ad426cabffb7f2ff5256a8ad7214c862a7aa2ab3e67c7a315a2c61e503805483812',
    updated_at = NOW()
WHERE id = '48244777-c7a4-4e30-be4b-fe1104e443b8';
