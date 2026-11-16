// One row per Member first, then histogram equal degree/grant/read/Unread/
// Mention tuples. Includes Members without usable DMs. Run outside timing.
export const histogramsSql = `
WITH usable_grants AS (
 SELECT cm.organization_id,cm.channel_id,cm.member_id,coalesce(p.read_seq,0) read_seq
 FROM channel_members cm
 JOIN users u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision
 LEFT JOIN channel_read_positions p ON p.organization_id=cm.organization_id AND p.member_id=cm.member_id AND p.channel_id=cm.channel_id
 WHERE cm.dm_created_at IS NOT NULL
), unread_per_member AS (
 SELECT g.organization_id,g.member_id,count(*) unread
 -- Preserve Messages as the outer input to avoid per-grant Message scans.
 -- The unmatched NULL-Member group cannot join to per_member below.
 FROM messages m LEFT JOIN usable_grants g ON g.organization_id=m.organization_id AND g.channel_id=m.channel_id AND m.seq>g.read_seq AND m.sender<>g.member_id
 GROUP BY g.organization_id,g.member_id
), per_member AS (
 SELECT u.organization_id,u.id,u.role,u.membership_revision,
 count(cm.channel_id) degree,
 count(cm.channel_id) FILTER(WHERE cm.membership_revision=u.membership_revision) usable,
 count(p.channel_id) read_positions,
 coalesce(min(p.read_seq),0) min_read,coalesce(max(p.read_seq),0) max_read,
 0 mention
 FROM users u LEFT JOIN channel_members cm ON cm.organization_id=u.organization_id AND cm.member_id=u.id AND cm.dm_created_at IS NOT NULL
 LEFT JOIN channel_read_positions p ON p.organization_id=cm.organization_id AND p.member_id=cm.member_id AND p.channel_id=cm.channel_id
 GROUP BY u.organization_id,u.id,u.role,u.membership_revision
)
SELECT coalesce(json_agg(t),'[]') FROM (
 SELECT u.organization_id,role,membership_revision,degree,usable,read_positions,min_read,max_read,coalesce(n.unread,0) unread,mention,count(*) members
 FROM per_member u LEFT JOIN unread_per_member n ON n.organization_id=u.organization_id AND n.member_id=u.id
 GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 1,2,3,4,5,6,7,8,9,10
) t;
`;
// #152 is absent: fixture/workload contain no Mention syntax, hence zero.
// Unread counts only other-sender Messages after the usable grant's position.
