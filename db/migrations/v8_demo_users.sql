-- ============================================================
-- v8_demo_users — Seed demo accounts for testing connections
-- Run on both stage and prod Neon instances
-- ============================================================

-- Demo users (minimal profiles — tests incomplete profile fallback)

INSERT INTO users (user_id, name, email, status)
VALUES
  ('priya-sharma-demo', 'Priya Sharma', 'priya.sharma@demo.hops', 'active'),
  ('jordan-mitchell-demo', 'Jordan Mitchell', 'jordan.mitchell@demo.hops', 'active'),
  ('elena-vasquez-demo', 'Elena Vasquez', 'elena.vasquez@demo.hops', 'active'),
  ('marcus-chen-demo', 'Marcus Chen', 'marcus.chen@demo.hops', 'active')
ON CONFLICT (email) DO NOTHING;

-- Create profile rows with just a title (no bio, no experience, no education, no skills)

INSERT INTO profile (id, title, status)
SELECT id, 'Product Lead', 'public'
FROM users WHERE email = 'priya.sharma@demo.hops'
ON CONFLICT (id) DO NOTHING;

INSERT INTO profile (id, title, status)
SELECT id, 'Software Architect', 'public'
FROM users WHERE email = 'jordan.mitchell@demo.hops'
ON CONFLICT (id) DO NOTHING;

INSERT INTO profile (id, title, status)
SELECT id, 'Design Director', 'public'
FROM users WHERE email = 'elena.vasquez@demo.hops'
ON CONFLICT (id) DO NOTHING;

INSERT INTO profile (id, title, status)
SELECT id, 'Founding Partner', 'public'
FROM users WHERE email = 'marcus.chen@demo.hops'
ON CONFLICT (id) DO NOTHING;
