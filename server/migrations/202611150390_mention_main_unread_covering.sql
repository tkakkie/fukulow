-- Mention counts join accepted sets by Message id. Keep the existing exact
-- main-scope range index covering after that join adds id to the projection.
DROP INDEX messages_main_unread_covering;
CREATE INDEX messages_main_unread_covering
    ON messages(organization_id,channel_id,seq) INCLUDE(sender,id)
    WHERE topic_id IS NULL;
