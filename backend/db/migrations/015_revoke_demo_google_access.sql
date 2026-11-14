-- Migration 015: Revoke any Google/Gmail OAuth tokens attached to the public Demo Account
-- Ensures personal Gmail or Google Workspace OAuth credentials cannot be exposed via Demo Mode.

BEGIN;

DELETE FROM google_auth_tokens
WHERE user_id = '10000000-0000-4000-8000-000000000001'
   OR user_id IN (
     SELECT id FROM users
     WHERE LOWER(email) = 'demo@maxitext.studio'
   );

COMMIT;
