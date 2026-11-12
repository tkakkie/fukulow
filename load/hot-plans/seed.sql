-- #314 hot-query plan dataset. Run as the database owner after migrations, on a
-- throwaway database only. Deterministic ids so plans.sql can name them.
-- Org A: 10,000 Members, 40 public + 10 private Channels, hot Channel with
-- 100,000 Messages (2,000 Topics hold 70%), 2,000 Messages in every other Channel.
-- Org B: 1,000 Members, 10 public Channels, 5,000 Messages each (cross-Org noise).
\set ON_ERROR_STOP on
SET synchronous_commit = off;

CREATE TEMP TABLE orgs (org uuid, tag text, members int, public_channels int, private_channels int, per_channel int);
INSERT INTO orgs VALUES
  ('00000000-0000-4000-8000-00000000000a', 'a', 10000, 40, 10, 2000),
  ('00000000-0000-4000-8000-00000000000b', 'b', 1000, 10, 0, 5000);

INSERT INTO organizations (organization_id, name) SELECT org, 'Org ' || tag FROM orgs;
INSERT INTO accounts (id, email, password_hash)
SELECT md5('acct-' || tag || '-' || g)::uuid, 'm' || g || '@' || tag || '.invalid', 'x'
FROM orgs, generate_series(1, members) g;
-- Member 1 is the owner; Member 2 is the measured ordinary Member.
INSERT INTO users (organization_id, id, name, role, account_id)
SELECT org, md5('user-' || tag || '-' || g)::uuid, 'Member ' || g,
       CASE WHEN g = 1 THEN 'owner' WHEN g % 50 = 0 THEN 'guest' ELSE 'member' END,
       md5('acct-' || tag || '-' || g)::uuid
FROM orgs, generate_series(1, members) g;
INSERT INTO account_sessions (token_hash, account_id)
VALUES (sha256('hot-plans-session'), md5('acct-a-2')::uuid);

INSERT INTO channels (organization_id, id, name, visibility)
SELECT org, md5('chan-' || tag || '-' || g)::uuid, 'channel-' || g,
       CASE WHEN g <= public_channels THEN 'public' ELSE 'private' END
FROM orgs, generate_series(1, public_channels + private_channels) g;
-- Private grants: Members 1-500 of Org A in every private Channel.
INSERT INTO channel_members (organization_id, channel_id, member_id, membership_revision)
SELECT o.org, md5('chan-a-' || c)::uuid, md5('user-a-' || u)::uuid, 0
FROM orgs o, generate_series(41, 50) c, generate_series(1, 500) u WHERE o.tag = 'a';

-- Hot Channel = Org A channel-1. Topic t holds seqs where seq % 10 < 7.
INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
SELECT org, md5('chan-a-1')::uuid, md5('topic-a-1-' || t)::uuid, 'topic ' || t, 1, 1, 1
FROM orgs, generate_series(0, 1999) t WHERE tag = 'a';
CREATE TEMP TABLE counts (org uuid, tag text, channel int, n int);
INSERT INTO counts SELECT org, tag, c, CASE WHEN tag = 'a' AND c = 1 THEN 100000 ELSE per_channel END
FROM orgs, generate_series(1, public_channels + private_channels) c;
INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, created_at)
SELECT k.org, md5('msg-' || k.tag || '-' || k.channel || '-' || s)::uuid, md5('chan-' || k.tag || '-' || k.channel)::uuid, s,
       md5('user-' || k.tag || '-' || (1 + s % 200))::uuid, md5('cmid-' || k.tag || '-' || k.channel || '-' || s)::uuid,
       'message body ' || s,
       CASE WHEN k.tag = 'a' AND k.channel = 1 AND s % 10 < 7 THEN md5('topic-a-1-' || ((s / 10) % 2000))::uuid END,
       timestamptz '2026-11-01' + s * interval '1 second'
FROM counts k, generate_series(1, k.n) s;
UPDATE topics t SET first_seq = a.first_seq, last_seq = a.last_seq, message_count = a.n
FROM (SELECT organization_id, topic_id, min(seq) first_seq, max(seq) last_seq, count(*) n
      FROM messages WHERE topic_id IS NOT NULL GROUP BY 1, 2) a
WHERE t.organization_id = a.organization_id AND t.id = a.topic_id;
INSERT INTO channel_message_sequences (organization_id, channel_id, seq)
SELECT organization_id, channel_id, max(seq) FROM messages GROUP BY 1, 2;

-- Every Member has read everything but the last 100 Messages of each Channel.
-- Only the measured Member gets Topic positions (all 2,000, same cut-off), so
-- its hot-Channel Unread is also the last 100 Messages; other Members fall back
-- to initial_seq for Topics, which the measured queries never read.
UPDATE channel_read_positions p SET read_seq = greatest(p.initial_seq, s.seq - 100)
FROM channel_message_sequences s WHERE s.organization_id = p.organization_id AND s.channel_id = p.channel_id;
INSERT INTO topic_read_positions (organization_id, channel_id, member_id, topic_id, read_seq)
SELECT t.organization_id, t.channel_id, md5('user-a-2')::uuid, t.id, least(t.last_seq, s.seq - 100)
FROM topics t JOIN channel_message_sequences s ON s.organization_id = t.organization_id AND s.channel_id = t.channel_id
WHERE t.channel_id = md5('chan-a-1')::uuid;
ANALYZE;
