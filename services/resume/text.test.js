const {
  stripPII, cleanText, rejoinWrappedUrls, rejoinWrappedEmails, rejoinHyphenatedBreaks,
  extractUrls, looksLikeResume, prepareResumeText,
} = require('./text');
const { UnprocessableError } = require('../../utils/errors');

describe('stripPII: dates survive', () => {
  const dates = [
    '2019 - 2021', '2019–21', '2019 – 2021', '2019—2021', '2019-21', '2019/20',
    '03/2021 – 06/2022', '03/2021 - 06/2022', '03.2021 - 06.2022', '3-2021 - 6-2022',
    '15.03.2021 - 30.06.2022', '2021-03-15 - 2022-06-30', '2021/03 - 2022/06',
    'Mar 2021 - Present', 'March 2021 - June 2022', 'März 2021 – heute', 'marzo 2021 – actualidad',
    'September 2019 - Present (5 years 1 month)', '2015 - 2019 2019 - 2021',
    'B.Tech, 2015–19', 'Jan 2020 – Dec 2021 · 2 yrs',
  ];
  for (const d of dates) it(JSON.stringify(d), () => expect(stripPII(d)).toBe(d));
  it('multi-line block of ranges survives', () => {
    const block = '2019 - 2021\n2021 - 2023\n03/2021 – 06/2022\n2015 - 2019';
    expect(stripPII(block)).toBe(block);
  });
});

describe('stripPII: phones and emails become placeholders', () => {
  const cases = [
    ['+91 98765 43210', '[phone]'],
    ['(415) 555-0132', '[phone]'],
    ['+1 (415) 555-0132', '[phone]'],
    ['415.555.0132', '[phone]'],
    ['415-555-0132', '[phone]'],
    ['9876543210', '[phone]'],
    ['+919876543210', '[phone]'],
    ['+49 30 12345678', '[phone]'],
    ['+44 20 7946 0958', '[phone]'],
    ['Phone: +91 98765 43210 | Email: a.b+c@example.co.in', 'Phone: [phone] | Email: [email]'],
    ['alex.synthetic@example.com', '[email]'],
    ['+91 98765 43210\n2019 – 21', '[phone]\n2019 – 21'],
    ['(415) 555-0132\n2019 - 2021', '[phone]\n2019 - 2021'],
    ['+91 98765 43210 2019 - 2021', '[phone] 2019 - 2021'],
    ['Mar 2021 - Present | +91 98765 43210', 'Mar 2021 - Present | [phone]'],
  ];
  for (const [input, want] of cases) it(JSON.stringify(input), () => expect(stripPII(input)).toBe(want));
  it('leaves short numbers alone', () => {
    for (const s of ['4M transactions', '10,000+ users', 'Page 1 of 2', '60 percent', 'INV-2024-0042']) {
      expect(stripPII(s)).toBe(s);
    }
  });
  it('is idempotent', () => {
    const once = stripPII('a@b.io (415) 555-0132 +91 98765 43210');
    expect(stripPII(once)).toBe(once);
  });
});

describe('cleanup', () => {
  it('rejoins LinkedIn wrapped URLs and keeps labels', () => {
    const t = 'Contact\nwww.linkedin.com/in/\njane-doe-1234 (LinkedIn)\njane.github.io (Portfolio)\nmedium.com/\n@janedoe (Blog)\nTop Skills';
    expect(rejoinWrappedUrls(t)).toBe('Contact\nwww.linkedin.com/in/jane-doe-1234 (LinkedIn)\njane.github.io (Portfolio)\nmedium.com/@janedoe (Blog)\nTop Skills');
  });
  it('rejoins a multi-line URL but stops at the next heading', () => {
    const t = 'https://www.example-portfolio-\nsite.dev/projects/a/\ncase-studies/ledger-2022\nSKILLS';
    expect(rejoinWrappedUrls(t)).toBe('https://www.example-portfolio-site.dev/projects/a/case-studies/ledger-2022\nSKILLS');
  });
  it('does not join a URL with a following URL or email', () => {
    expect(rejoinWrappedUrls('github.com/jane/\nwww.jane.dev')).toBe('github.com/jane/\nwww.jane.dev');
    expect(rejoinWrappedUrls('github.com/jane/\njane@x.io')).toBe('github.com/jane/\njane@x.io');
  });
  it('rejoins hyphenated line breaks, keeping the hyphen', () => {
    expect(rejoinHyphenatedBreaks('ledger infra-\nstructure')).toBe('ledger infra-structure');
    expect(rejoinHyphenatedBreaks('Contract-\nTests')).toBe('Contract-Tests');
    expect(rejoinHyphenatedBreaks('2019 -\n2021')).toBe('2019 -\n2021');
  });
  it('does not glue a heading onto a URL ending in a slash', () => {
    expect(rejoinWrappedUrls('site.dev/projects/case-studies/\nSKILLS')).toBe('site.dev/projects/case-studies/\nSKILLS');
  });
  it('rejoins a LinkedIn-wrapped email, and strip catches it even if not rejoined', () => {
    expect(rejoinWrappedEmails('Contact\njane.doe.example@gmail.c\nom\nwww.x.dev')).toBe('Contact\njane.doe.example@gmail.com\nwww.x.dev');
    expect(rejoinWrappedEmails('jane@x.io\n9876543210')).toBe('jane@x.io\n9876543210');
    expect(stripPII('jane.doe.example@gmail.c\nom')).toBe('[email]\nom');
    expect(stripPII('Engineer @ Acme, Engineer@Acme, medium.com/@jane')).toBe('Engineer @ Acme, Engineer@Acme, medium.com/@jane');
    expect(cleanText('Contact\njane.doe.example@gmail.c\nom')).toBe('Contact\njane.doe.example@gmail.com');
  });
  it('collapses whitespace, removes NBSP / soft hyphens / zero-width, drops LinkedIn footers', () => {
    expect(cleanText('a \u00A0  b\r\n\n\n\nPage 1 of 2\nc\u00AD d\u200B')).toBe('a b\n\nc d');
  });
});

describe('extractUrls', () => {
  it('types links by domain, then LinkedIn label', () => {
    const urls = extractUrls('www.linkedin.com/in/jane (LinkedIn)\njane.dev (Portfolio)\nmedium.com/@jane (Blog)\nhttps://github.com/jane.\nB.Tech, Node.js');
    expect(urls.map((u) => [u.url, u.type])).toEqual([
      ['www.linkedin.com/in/jane', 'linkedin'], ['jane.dev', 'portfolio'], ['medium.com/@jane', 'portfolio'], ['https://github.com/jane', 'github'],
    ]);
  });
  it('does not treat an email as a URL', () => {
    expect(extractUrls('mail jane@example.com')).toEqual([]);
  });
});

describe('looksLikeResume', () => {
  it('needs a heading plus a year range or contact details', () => {
    expect(looksLikeResume('Experience\nEngineer 2019 - 2021')).toBe(true);
    expect(looksLikeResume('Berufserfahrung\nMärz 2021 – heute')).toBe(true);
    expect(looksLikeResume('Invoice date 14 Feb 2024. Total due 6,004.43')).toBe(false);
    // contact + year range but no section heading (an invoice)
    expect(looksLikeResume('INVOICE\nbilling@vendor.com +1 (415) 555-0199\nService period 2023 - 2024')).toBe(false);
  });
});

describe('prepareResumeText', () => {
  const body = `Jane Doe\njane@example.com +91 98765 43210\ngithub.com/jane\nExperience\nEngineer, Acme 2019 - 2021\n${'Built things. '.repeat(30)}`;
  const limits = { minChars: 300, maxChars: 30000 };

  it('cleans, strips PII, extracts links', () => {
    const r = prepareResumeText(body, limits);
    expect(r.text).toContain('[email] [phone]');
    expect(r.text).not.toContain('jane@example.com');
    expect(r.text).not.toContain('98765');
    expect(r.regexLinks.map((l) => l.type)).toEqual(['github']);
    expect(r.warnings).toEqual([]);
  });
  it('truncates long input with a warning', () => {
    const r = prepareResumeText(body, { minChars: 300, maxChars: 350 });
    expect(r.warnings).toEqual(['input_truncated']);
    expect(r.text.length).toBeLessThanOrEqual(350);
  });
  it('throws 422 scanned for too little text and not_a_resume for prose', () => {
    const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };
    const scanned = err(() => prepareResumeText('Experience 2019 - 2021', limits));
    expect(scanned).toBeInstanceOf(UnprocessableError);
    expect(scanned.code).toBe('scanned');
    expect(err(() => prepareResumeText('Lorem ipsum dolor sit amet. '.repeat(20), limits)).code).toBe('not_a_resume');
  });
});
