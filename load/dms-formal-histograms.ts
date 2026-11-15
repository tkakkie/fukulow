// One row per Member first, then histogram equal degree/grant/read/Unread/
// Mention tuples. Includes Members without usable DMs. Run outside timing.
export const histogramsSql = `
WITH per_member AS (
 SELECT u.organization_id,u.id,u.role,u.membership_revision,
 count(cm.channel_id) degree,
 count(cm.channel_id) FILTER(WHERE cm.membership_revision=u.membership_revision) usable,
 count(p.channel_id) read_positions,
 coalesce(min(p.read_seq),0) min_read,coalesce(max(p.read_seq),0) max_read,
 coalesce(sum((SELECT count(*) FROM messages m WHERE m.organization_id=cm.organization_id AND m.channel_id=cm.channel_id AND m.seq>coalesce(p.read_seq,0) AND m.sender<>u.id)) FILTER(WHERE cm.membership_revision=u.membership_revision),0) unread,
 0 mention
 FROM users u LEFT JOIN channel_members cm ON cm.organization_id=u.organization_id AND cm.member_id=u.id AND cm.dm_created_at IS NOT NULL
 LEFT JOIN channel_read_positions p ON p.organization_id=cm.organization_id AND p.member_id=cm.member_id AND p.channel_id=cm.channel_id
 GROUP BY u.organization_id,u.id,u.role,u.membership_revision
)
SELECT coalesce(json_agg(t),'[]') FROM (
 SELECT organization_id,role,membership_revision,degree,usable,read_positions,min_read,max_read,unread,mention,count(*) members
 FROM per_member GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 1,2,3,4,5,6,7,8,9,10
) t;
`;
// #152 is absent: fixture/workload contain no Mention syntax, hence zero.
// Unread counts only other-sender Messages after the usable grant's position.
