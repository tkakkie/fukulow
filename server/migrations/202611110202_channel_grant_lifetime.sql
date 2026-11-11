-- Channel grants have a lifetime independent of Organization Membership revision.
-- DELETE + INSERT and explicit renewal can never revive an old subscription.
ALTER TABLE channel_members ADD COLUMN grant_id uuid NOT NULL DEFAULT gen_random_uuid();
