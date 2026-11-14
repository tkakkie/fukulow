-- Exact main-scope Unread counts need sender after the seq range bound. Avoid
-- fetching every 1 KiB Message body from the heap merely to exclude own sends.
CREATE INDEX messages_main_unread_covering
    ON messages(organization_id,channel_id,seq) INCLUDE(sender)
    WHERE topic_id IS NULL;
