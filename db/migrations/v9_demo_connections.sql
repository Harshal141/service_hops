-- ============================================================
-- v9_demo_connections — Seed a connection graph with real multi-hop paths
-- Depends on: v7_connection.sql, v8_demo_users.sql
-- STAGE ONLY — do not run on prod (demo users must never reach prod)
-- ============================================================
--
-- Graph shape (hp is the real signed-in account):
--
--     hp ── Priya ── Jordan ── Elena
--             │                 │
--             └─── Marcus ──────┘
--
-- From hp's perspective:
--   Priya   1 hop  (direct — excluded from /connection/reachable)
--   Jordan  2 hops via Priya
--   Marcus  2 hops via Priya
--   Elena   3 hops via Priya  (two distinct 3-hop paths — exercises the
--                              DISTINCT ON shortest-path dedup)
--
-- Re-runnable: ON CONFLICT DO NOTHING hits the uq_conn_pair partial index.

WITH ids AS (
  SELECT
    (SELECT id FROM users WHERE user_id = 'harshal-patil-dsi9')      AS hp,
    (SELECT id FROM users WHERE email = 'priya.sharma@demo.hops')    AS priya,
    (SELECT id FROM users WHERE email = 'jordan.mitchell@demo.hops') AS jordan,
    (SELECT id FROM users WHERE email = 'elena.vasquez@demo.hops')   AS elena,
    (SELECT id FROM users WHERE email = 'marcus.chen@demo.hops')     AS marcus
),
edges AS (
            SELECT hp     AS a, priya  AS b,
                   'Shipped the payments rewrite together.'        AS note_a,
                   'Sharpest engineer I have worked alongside.'    AS note_b  FROM ids
  UNION ALL SELECT priya,  jordan,
                   'He architected the system my team runs on.',
                   'She turned a vague roadmap into something buildable.'     FROM ids
  UNION ALL SELECT priya,  marcus,
                   'Backed our seed round and stayed useful after.',
                   'Best product instincts of anyone I have funded.'          FROM ids
  UNION ALL SELECT jordan, elena,
                   'Her design reviews changed how I think about APIs.',
                   'Rare engineer who actually reads the research.'           FROM ids
  UNION ALL SELECT marcus, elena,
                   'She rebuilt our portfolio brand from nothing.',
                   'Gave me my first design director role.'                   FROM ids
)
INSERT INTO connection (user_a_id, user_b_id, note_by_a, note_by_b)
SELECT a, b, note_a, note_b
FROM edges
WHERE a IS NOT NULL AND b IS NOT NULL
ON CONFLICT DO NOTHING;

-- Verify (expect 5 active edges):
--   SELECT count(*) FROM connection WHERE status = 'active';
