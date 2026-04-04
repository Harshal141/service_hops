-- ============================================================
-- v5_skill_seed — Skill taxonomy seed data
-- Level 1: Category  |  Level 2: Subcategory  |  Level 3: Skill
-- Only level 3 rows can be tagged to profiles
-- Run on both stage and prod Neon instances
-- ============================================================

-- ============================================================
-- LEVEL 1 — Categories
-- ============================================================
INSERT INTO skill (name, level, parent_id, user_created, status) VALUES
  ('Engineering',  1, NULL, false, 'active'),  -- id 1
  ('Product',      1, NULL, false, 'active'),  -- id 2
  ('Leadership',   1, NULL, false, 'active'),  -- id 3
  ('Investing',    1, NULL, false, 'active'),  -- id 4
  ('Design',       1, NULL, false, 'active');  -- id 5


-- ============================================================
-- LEVEL 2 — Subcategories
-- ============================================================

-- Engineering subcategories
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 2, (SELECT id FROM skill WHERE name = 'Engineering' AND level = 1), false, 'active'
FROM (VALUES
  ('Application Engineering'),
  ('Infrastructure & Ops'),
  ('Data & AI'),
  ('Specialized Engineering')
) AS t(name);

-- Product subcategories
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 2, (SELECT id FROM skill WHERE name = 'Product' AND level = 1), false, 'active'
FROM (VALUES
  ('Product Management'),
  ('Product Strategy'),
  ('Growth & Analytics'),
  ('Technical Program Management')
) AS t(name);

-- Leadership subcategories
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 2, (SELECT id FROM skill WHERE name = 'Leadership' AND level = 1), false, 'active'
FROM (VALUES
  ('Engineering Management'),
  ('Executive Leadership'),
  ('Operations'),
  ('People & Culture')
) AS t(name);

-- Investing subcategories
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 2, (SELECT id FROM skill WHERE name = 'Investing' AND level = 1), false, 'active'
FROM (VALUES
  ('Venture Capital'),
  ('Angel Investing'),
  ('Corporate Finance'),
  ('Business Development')
) AS t(name);

-- Design subcategories
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 2, (SELECT id FROM skill WHERE name = 'Design' AND level = 1), false, 'active'
FROM (VALUES
  ('Product Design'),
  ('Brand & Visual'),
  ('Research & Strategy')
) AS t(name);


-- ============================================================
-- LEVEL 3 — Skills (taggable)
-- ============================================================

-- Application Engineering
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Application Engineering' AND level = 2), false, 'active'
FROM (VALUES
  ('Frontend Engineering'),
  ('Backend Engineering'),
  ('Full-Stack Engineering'),
  ('Mobile Engineering'),
  ('API Design'),
  ('Real-Time Systems'),
  ('Developer Tooling')
) AS t(name);

-- Infrastructure & Ops
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Infrastructure & Ops' AND level = 2), false, 'active'
FROM (VALUES
  ('DevOps'),
  ('Site Reliability Engineering (SRE)'),
  ('Platform Engineering'),
  ('Cloud Infrastructure'),
  ('Networking'),
  ('Observability & Monitoring'),
  ('Incident Management')
) AS t(name);

-- Data & AI
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Data & AI' AND level = 2), false, 'active'
FROM (VALUES
  ('Data Engineering'),
  ('Data Architecture'),
  ('Machine Learning Engineering'),
  ('AI / LLM Engineering'),
  ('Analytics Engineering'),
  ('Streaming & Real-Time Data'),
  ('Database Engineering')
) AS t(name);

-- Specialized Engineering
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Specialized Engineering' AND level = 2), false, 'active'
FROM (VALUES
  ('Distributed Systems'),
  ('Systems Programming'),
  ('Compilers & Languages'),
  ('Security Engineering'),
  ('Embedded Systems'),
  ('Blockchain & Web3'),
  ('Quality Engineering')
) AS t(name);

-- Product Management
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Product Management' AND level = 2), false, 'active'
FROM (VALUES
  ('Product Roadmapping'),
  ('User Story Mapping'),
  ('Prioritization Frameworks'),
  ('Agile / Scrum'),
  ('B2B Product'),
  ('B2C Product'),
  ('Platform Product'),
  ('Developer Experience (DX)')
) AS t(name);

-- Product Strategy
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Product Strategy' AND level = 2), false, 'active'
FROM (VALUES
  ('Go-to-Market Strategy'),
  ('Competitive Analysis'),
  ('Market Research'),
  ('Pricing Strategy'),
  ('Product-Led Growth')
) AS t(name);

-- Growth & Analytics
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Growth & Analytics' AND level = 2), false, 'active'
FROM (VALUES
  ('Product Analytics'),
  ('A/B Testing'),
  ('Funnel Optimization'),
  ('Retention & Engagement'),
  ('Mixpanel'),
  ('Amplitude')
) AS t(name);

-- Technical Program Management
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Technical Program Management' AND level = 2), false, 'active'
FROM (VALUES
  ('Cross-functional Execution'),
  ('OKR Planning'),
  ('Release Management'),
  ('Risk Management')
) AS t(name);

-- Engineering Management
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Engineering Management' AND level = 2), false, 'active'
FROM (VALUES
  ('Team Building & Hiring'),
  ('Technical Mentorship'),
  ('Engineering Culture'),
  ('Performance Reviews'),
  ('Org Design'),
  ('On-call & Incident Management')
) AS t(name);

-- Executive Leadership
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Executive Leadership' AND level = 2), false, 'active'
FROM (VALUES
  ('CTO / VP Engineering'),
  ('Board & Investor Relations'),
  ('Company Strategy'),
  ('Fundraising'),
  ('Scaling Startups'),
  ('M&A'),
  ('Executive Hiring')
) AS t(name);

-- Operations
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Operations' AND level = 2), false, 'active'
FROM (VALUES
  ('Business Operations'),
  ('Revenue Operations'),
  ('Finance Operations'),
  ('Process Improvement'),
  ('Legal & Compliance')
) AS t(name);

-- People & Culture
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'People & Culture' AND level = 2), false, 'active'
FROM (VALUES
  ('Talent Acquisition'),
  ('L&D / Upskilling'),
  ('Diversity & Inclusion'),
  ('Compensation Design'),
  ('HR Operations')
) AS t(name);

-- Venture Capital
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Venture Capital' AND level = 2), false, 'active'
FROM (VALUES
  ('Deal Sourcing'),
  ('Due Diligence'),
  ('Portfolio Management'),
  ('Term Sheet Negotiation'),
  ('Seed Investing'),
  ('Series A/B Investing'),
  ('Fund Management')
) AS t(name);

-- Angel Investing
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Angel Investing' AND level = 2), false, 'active'
FROM (VALUES
  ('Early-Stage Scouting'),
  ('Founder Advising'),
  ('Syndicate Investing'),
  ('Convertible Notes / SAFEs')
) AS t(name);

-- Corporate Finance
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Corporate Finance' AND level = 2), false, 'active'
FROM (VALUES
  ('Financial Modeling'),
  ('Valuation'),
  ('FP&A'),
  ('Capital Markets'),
  ('IPO / Exit Planning')
) AS t(name);

-- Business Development
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Business Development' AND level = 2), false, 'active'
FROM (VALUES
  ('Partnerships'),
  ('Enterprise Sales'),
  ('Channel Strategy'),
  ('Contract Negotiation'),
  ('Strategic Alliances')
) AS t(name);

-- Product Design
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Product Design' AND level = 2), false, 'active'
FROM (VALUES
  ('UX Design'),
  ('UI Design'),
  ('Interaction Design'),
  ('Design Systems'),
  ('Figma'),
  ('Prototyping'),
  ('Usability Testing')
) AS t(name);

-- Brand & Visual
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Brand & Visual' AND level = 2), false, 'active'
FROM (VALUES
  ('Brand Identity'),
  ('Illustration'),
  ('Motion Design'),
  ('Typography')
) AS t(name);

-- Research & Strategy
INSERT INTO skill (name, level, parent_id, user_created, status)
SELECT name, 3, (SELECT id FROM skill WHERE name = 'Research & Strategy' AND level = 2), false, 'active'
FROM (VALUES
  ('User Research'),
  ('Information Architecture'),
  ('Design Strategy'),
  ('Jobs-to-be-Done')
) AS t(name);
