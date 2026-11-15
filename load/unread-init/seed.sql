-- Owner-only deterministic fixture; all measured mutations run as fukulow_app.
INSERT INTO organizations (organization_id,name) VALUES (md5('org')::uuid,'Unread init'),(md5('foreign')::uuid,'Foreign noise');
INSERT INTO accounts (id,email,password_hash)
SELECT md5('account-'||g)::uuid,'u'||g||'@unread.invalid','test-only' FROM generate_series(0,@members@+1) g;
INSERT INTO users (organization_id,id,name,role,account_id)
SELECT md5('org')::uuid,md5('member-'||g)::uuid,'Member '||g,
 CASE WHEN g=0 THEN 'owner' WHEN @guest@ AND g=1 THEN 'guest' ELSE 'member' END,md5('account-'||g)::uuid
FROM generate_series(0,@members@) g;
INSERT INTO users (organization_id,id,name,role,account_id)
VALUES(md5('foreign')::uuid,md5('foreign-member')::uuid,'Foreign','member',md5('account-'||(@members@+1))::uuid);
INSERT INTO channels (organization_id,id,name,visibility)
SELECT md5('org')::uuid,md5('channel-'||g)::uuid,'channel-'||g,'private' FROM generate_series(1,@channels@)g;
INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count)
SELECT md5('org')::uuid,md5('channel-'||c)::uuid,md5('topic-'||c||'-'||t)::uuid,'Topic '||t,t,t,1
FROM generate_series(1,@channels@)c,generate_series(1,@topics@)t;
INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,created_at)
SELECT md5('org')::uuid,md5('old-'||c||'-'||t)::uuid,md5('channel-'||c)::uuid,t,md5('member-0')::uuid,md5('old-'||c||'-'||t)::uuid,'old',md5('topic-'||c||'-'||t)::uuid,timestamptz '2026-11-01'
FROM generate_series(1,@channels@)c,generate_series(1,@topics@)t;
INSERT INTO channel_message_sequences (organization_id,channel_id,seq)
SELECT md5('org')::uuid,md5('channel-'||c)::uuid,@topics@ FROM generate_series(1,@channels@)c;
-- Sender always has access. Its eager Topic rows are identical background noise.
INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision)
SELECT md5('org')::uuid,md5('channel-'||c)::uuid,md5('member-0')::uuid,0 FROM generate_series(1,@channels@)c;
