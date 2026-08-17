-- ============================================================
-- v11_demo_profiles — randomise demo handles and populate demo profiles
-- Targets: STAGE ONLY — never run on prod
-- Depends on: v6 (education.year is TEXT), v8_demo_users.sql, v9_demo_connections.sql
-- ============================================================
--
-- Two problems with the demo cohort as seeded by v8:
--   1. Handles were guessable (`priya-sharma-demo`), which advertises that these
--      are fixtures and collides with the "random user id" requirement.
--   2. Every demo user had a title and nothing else, so opening one from the
--      graph rendered the "This profile is not yet complete" empty state — the
--      connection features looked broken even when they worked.
--
-- These accounts are deliberately UNUSABLE AS LOGINS. Sign-in matches on email
-- (userService.upsert → ON CONFLICT (email)), and `.hops` is not a real TLD, so
-- no LinkedIn account can ever hold one of these addresses. They exist purely to
-- be interacted with.
--
-- Demo users are a single global cohort seeded here — nothing at runtime creates
-- them, and none are created per real user.
--
-- Everything is keyed on the '%@demo.hops' email marker so v12 can remove the
-- whole cohort in one statement at go-live.
--
-- Idempotent: safe to re-run.

-- ── John Doe joins the cohort ─────────────────────────────

INSERT INTO users (user_id, name, email, status)
VALUES ('john-doe-34f6ae', 'John Doe', 'john.doe@demo.hops', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO profile (id, title, status)
SELECT id, 'Staff Engineer', 'public' FROM users WHERE email = 'john.doe@demo.hops'
ON CONFLICT (id) DO NOTHING;

-- ── Randomise the guessable handles ───────────────────────

UPDATE users SET user_id = 'priya-sharma-411898'    WHERE email = 'priya.sharma@demo.hops';
UPDATE users SET user_id = 'jordan-mitchell-515b7d' WHERE email = 'jordan.mitchell@demo.hops';
UPDATE users SET user_id = 'elena-vasquez-affa0c'   WHERE email = 'elena.vasquez@demo.hops';
UPDATE users SET user_id = 'marcus-chen-10d9f1'     WHERE email = 'marcus.chen@demo.hops';

-- ── Bio / location on every demo profile ──────────────────

UPDATE profile p SET
  bio = v.bio,
  location = v.location
FROM (VALUES
  ('priya.sharma@demo.hops',
   'Product lead who prefers shipping a rough thing this week over a perfect thing next quarter. Spent the last six years on payments and billing, mostly undoing my own earlier decisions.',
   'Bengaluru, India'),
  ('jordan.mitchell@demo.hops',
   'Architect by title, debugger by trade. I care about systems that are boring to operate at 3am and I will argue about queue semantics for longer than anyone wants.',
   'Austin, TX'),
  ('elena.vasquez@demo.hops',
   'Design director. I think most product problems are actually naming problems. Previously built the design system three companies are still using.',
   'Barcelona, Spain'),
  ('marcus.chen@demo.hops',
   'Founding partner, early-stage. Former operator, so I am useful for about two things and try not to pretend otherwise. Writes the cheque, then gets out of the way.',
   'Singapore'),
  ('john.doe@demo.hops',
   'Staff engineer working on developer platforms. Happiest when I delete more code than I add. Currently obsessed with making local development stop being a personality test.',
   'Manchester, UK')
) AS v(email, bio, location)
JOIN users u ON u.email = v.email
WHERE p.id = u.id;

-- ── Links ─────────────────────────────────────────────────

INSERT INTO profile_link (profile_id, type, url, sort_order)
SELECT u.id, v.type, v.url, v.sort_order
FROM (VALUES
  ('priya.sharma@demo.hops',    'linkedin', 'https://www.linkedin.com/in/priya-sharma-demo',   0),
  ('priya.sharma@demo.hops',    'website',  'https://priyasharma.example',                     1),
  ('jordan.mitchell@demo.hops', 'github',   'https://github.com/jordan-mitchell-demo',         0),
  ('jordan.mitchell@demo.hops', 'linkedin', 'https://www.linkedin.com/in/jordan-mitchell-demo', 1),
  ('elena.vasquez@demo.hops',   'website',  'https://elenavasquez.example',                    0),
  ('marcus.chen@demo.hops',     'linkedin', 'https://www.linkedin.com/in/marcus-chen-demo',    0),
  ('john.doe@demo.hops',        'github',   'https://github.com/john-doe-demo',                0),
  ('john.doe@demo.hops',        'linkedin', 'https://www.linkedin.com/in/john-doe-demo',       1)
) AS v(email, type, url, sort_order)
JOIN users u ON u.email = v.email
WHERE NOT EXISTS (
  SELECT 1 FROM profile_link pl WHERE pl.profile_id = u.id AND pl.url = v.url
);

-- ── Experience ────────────────────────────────────────────

INSERT INTO profile_experience (profile_id, company, role, started_at, ended_at, currently_working, description, sort_order)
SELECT u.id, v.company, v.role, v.started_at::date, v.ended_at::date, v.currently_working, v.description, v.sort_order
FROM (VALUES
  ('priya.sharma@demo.hops', 'Northwind Payments', 'Product Lead',        '2021-03-01', NULL,         TRUE,  'Own the billing and payouts surface. Took the checkout rewrite from a six-month estimate to a staged rollout that shipped in nine weeks.', 0),
  ('priya.sharma@demo.hops', 'Ledgerly',           'Senior PM',           '2018-06-01', '2021-02-01', FALSE, 'First PM on the reconciliation product. Grew it from an internal tool to a third of company revenue.', 1),
  ('jordan.mitchell@demo.hops', 'Northwind Payments', 'Software Architect', '2020-01-01', NULL,        TRUE,  'Designed the event backbone the payments and risk teams both run on. On call for it, which keeps the design honest.', 0),
  ('jordan.mitchell@demo.hops', 'Corvid Systems',    'Staff Engineer',     '2016-09-01', '2019-12-01', FALSE, 'Rebuilt the ingestion pipeline to handle a 40x traffic increase without adding headcount.', 1),
  ('elena.vasquez@demo.hops', 'Studio Meridian',    'Design Director',    '2019-05-01', NULL,         TRUE,  'Lead a team of eight across product and brand. Shipped the design system now used by every surface.', 0),
  ('elena.vasquez@demo.hops', 'Foldwork',           'Senior Product Designer', '2015-02-01', '2019-04-01', FALSE, 'Owned onboarding end to end. Cut time-to-first-value from eleven minutes to under two.', 1),
  ('marcus.chen@demo.hops',  'Hallward Capital',    'Founding Partner',   '2017-01-01', NULL,         TRUE,  'Seed and pre-seed, mostly infrastructure and fintech. 40-odd investments, a handful of which I am genuinely proud of.', 0),
  ('marcus.chen@demo.hops',  'Tessera',             'COO',                '2012-04-01', '2016-11-01', FALSE, 'Ran operations through the Series A to C stretch, 20 to 300 people.', 1),
  ('john.doe@demo.hops',     'Beacon Labs',         'Staff Engineer',     '2022-08-01', NULL,         TRUE,  'Developer platform team. Cut CI from 34 minutes to 6 and made local setup a single command.', 0),
  ('john.doe@demo.hops',     'Corvid Systems',      'Senior Engineer',    '2019-01-01', '2022-07-01', FALSE, 'Backend on the ingestion team. Wrote the retry semantics everyone quietly depends on.', 1)
) AS v(email, company, role, started_at, ended_at, currently_working, description, sort_order)
JOIN users u ON u.email = v.email
WHERE NOT EXISTS (
  SELECT 1 FROM profile_experience pe
  WHERE pe.profile_id = u.id AND pe.company = v.company AND pe.role = v.role
);

-- ── Education (year is TEXT as of v6, so ranges are allowed) ──

INSERT INTO profile_education (profile_id, institution, degree, year, sort_order)
SELECT u.id, v.institution, v.degree, v.year, v.sort_order
FROM (VALUES
  ('priya.sharma@demo.hops',    'Indian Institute of Technology, Bombay', 'B.Tech, Computer Science',      '2010-2014', 0),
  ('jordan.mitchell@demo.hops', 'University of Texas at Austin',          'BS, Computer Engineering',      '2008-2012', 0),
  ('elena.vasquez@demo.hops',   'Universitat de Barcelona',               'BA, Graphic Design',            '2007-2011', 0),
  ('elena.vasquez@demo.hops',   'Royal College of Art',                   'MA, Interaction Design',        '2012-2014', 1),
  ('marcus.chen@demo.hops',     'National University of Singapore',       'BBA, Finance',                  '2004-2008', 0),
  ('john.doe@demo.hops',        'University of Manchester',               'MEng, Software Engineering',    '2013-2017', 0)
) AS v(email, institution, degree, year, sort_order)
JOIN users u ON u.email = v.email
WHERE NOT EXISTS (
  SELECT 1 FROM profile_education pe
  WHERE pe.profile_id = u.id AND pe.institution = v.institution AND pe.degree = v.degree
);

-- ── Skills (level-3 ids from the v5 taxonomy) ─────────────

INSERT INTO profile_skill (profile_id, skill_id)
SELECT u.id, v.skill_id
FROM (VALUES
  -- Priya: product
  ('priya.sharma@demo.hops', 53), ('priya.sharma@demo.hops', 55), ('priya.sharma@demo.hops', 57),
  ('priya.sharma@demo.hops', 64), ('priya.sharma@demo.hops', 66), ('priya.sharma@demo.hops', 72),
  -- Jordan: engineering
  ('jordan.mitchell@demo.hops', 26), ('jordan.mitchell@demo.hops', 29), ('jordan.mitchell@demo.hops', 30),
  ('jordan.mitchell@demo.hops', 46), ('jordan.mitchell@demo.hops', 37), ('jordan.mitchell@demo.hops', 77),
  -- Elena: design
  ('elena.vasquez@demo.hops', 120), ('elena.vasquez@demo.hops', 123), ('elena.vasquez@demo.hops', 124),
  ('elena.vasquez@demo.hops', 131), ('elena.vasquez@demo.hops', 133), ('elena.vasquez@demo.hops', 122),
  -- Marcus: investing / leadership
  ('marcus.chen@demo.hops', 103), ('marcus.chen@demo.hops', 100), ('marcus.chen@demo.hops', 107),
  ('marcus.chen@demo.hops', 110), ('marcus.chen@demo.hops', 89), ('marcus.chen@demo.hops', 84),
  -- John: platform engineering
  ('john.doe@demo.hops', 34), ('john.doe@demo.hops', 32), ('john.doe@demo.hops', 60),
  ('john.doe@demo.hops', 45), ('john.doe@demo.hops', 52), ('john.doe@demo.hops', 31)
) AS v(email, skill_id)
JOIN users u ON u.email = v.email
JOIN skill s ON s.id = v.skill_id AND s.level = 3
ON CONFLICT DO NOTHING;

-- ── Connect John into the graph ───────────────────────────
-- John sits behind Jordan, so from hp he is 3 hops (hp -> Priya -> Jordan -> John).

WITH ids AS (
  SELECT
    (SELECT id FROM users WHERE email = 'jordan.mitchell@demo.hops') AS jordan,
    (SELECT id FROM users WHERE email = 'john.doe@demo.hops')        AS john
)
INSERT INTO connection (user_a_id, user_b_id, note_by_a, note_by_b)
SELECT jordan, john,
       'He owns the platform my services deploy onto and has never once broken me.',
       'Reviews my designs properly instead of rubber-stamping them.'
FROM ids
WHERE jordan IS NOT NULL AND john IS NOT NULL
ON CONFLICT DO NOTHING;

-- Verify:
--   SELECT u.name, u.user_id, p.title, p.location,
--          (SELECT count(*) FROM profile_skill s WHERE s.profile_id = u.id) AS skills
--   FROM users u JOIN profile p ON p.id = u.id
--   WHERE u.email LIKE '%@demo.hops' ORDER BY u.name;
