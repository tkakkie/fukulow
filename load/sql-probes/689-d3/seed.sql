CREATE FUNCTION probe_org(int) RETURNS uuid LANGUAGE sql IMMUTABLE RETURN
    ('00000000-0000-4000-8000-' || lpad(to_hex($1),12,'0'))::uuid;
CREATE FUNCTION probe_member(int,int) RETURNS uuid LANGUAGE sql IMMUTABLE RETURN
    ('00000000-0000-4000-8000-' || lpad(to_hex(1000+$1*100+$2),12,'0'))::uuid;
CREATE FUNCTION probe_channel(int,int) RETURNS uuid LANGUAGE sql IMMUTABLE RETURN
    ('00000000-0000-4000-8000-' || lpad(to_hex(10000+$1*100+$2),12,'0'))::uuid;

INSERT INTO public.users (organization_id, id, role)
SELECT probe_org(o), probe_member(o, n), CASE WHEN n = 3 THEN 'guest' ELSE 'member' END
FROM generate_series(1, 3) AS orgs(o), generate_series(1, 4) AS users(n);
INSERT INTO public.channels
SELECT probe_org(o), probe_channel(o, c),
    CASE WHEN c <= 3 THEN 'public' WHEN c <= 5 THEN 'private' END
FROM generate_series(1, 3) AS orgs(o), generate_series(1, 7) AS channels(c);
INSERT INTO public.channel_members (organization_id, channel_id, member_id)
SELECT probe_org(o), probe_channel(o, c), probe_member(o, n)
FROM generate_series(1, 3) AS orgs(o),
    (VALUES (2,3), (4,1), (4,2), (5,1), (5,4), (6,1), (6,2), (7,1), (7,4)) AS grants(c,n);

INSERT INTO public.messages
SELECT probe_org(o), o * 100000 + c * 2000 + n, probe_channel(o, c),
    timestamptz '2026-11-15 00:00:00+00' - (n / 3) * interval '1 hour',
    (ARRAY['開発の確認をお願いします。', '資料を共有しました。', '週末に更新します。'])[1 + (n % 3)]
    || CASE WHEN n % 97 = 0 THEN '確認を再度お願いします。' ELSE '' END
    || CASE WHEN n = 10 THEN '麒麟便　特殊照合' WHEN n = 11 THEN '麒と麟　特殊照会' ELSE '' END
    || CASE WHEN n = 12 THEN 'か' || chr(12441) || 'き' || chr(12441) WHEN n = 13 THEN 'がぎ' ELSE '' END
    || CASE WHEN n = 14 THEN 'x%y a_b c' || chr(92) || 'd'
            WHEN n = 15 THEN 'xZZy acb cd c/d' ELSE '' END
    || CASE WHEN n % 318 = 0 THEN ' 日程 🦉' ELSE '' END
    || ' note ' || (n % 100) || '。'
FROM generate_series(1, 3) AS orgs(o), generate_series(1, 7) AS channels(c),
     generate_series(1, 1000) AS messages(n);

-- Beyond the B1 window, and just after its end.
INSERT INTO public.messages VALUES
    (probe_org(1), 800001, probe_channel(1, 1), '2026-05-19 00:00:00+00', '境界 sentinel'),
    (probe_org(1), 800002, probe_channel(1, 1), '2026-05-18 23:59:59+00', '境界 sentinel'),
    (probe_org(1), 800003, probe_channel(1, 1), '2026-11-15 00:00:01+00', '境界 sentinel'),
    (probe_org(1), 800004, probe_channel(1, 1), '2026-11-15 00:00:00+00', '境界 sentinel');
