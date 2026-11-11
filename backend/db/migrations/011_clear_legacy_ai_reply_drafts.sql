UPDATE conversations
SET ai_draft_reply = NULL,
    ai_draft_category = NULL,
    ai_draft_missing_info = NULL,
    ai_draft_message_id = NULL,
    ai_draft_updated_at = NULL
WHERE ai_draft_reply IS NOT NULL
   OR ai_draft_category IS NOT NULL
   OR ai_draft_missing_info IS NOT NULL
   OR ai_draft_message_id IS NOT NULL
   OR ai_draft_updated_at IS NOT NULL;

UPDATE messages
SET ai_suggestion = NULL,
    ai_category = NULL,
    ai_missing_info = NULL
WHERE ai_suggestion IS NOT NULL
   OR ai_category IS NOT NULL
   OR ai_missing_info IS NOT NULL;
