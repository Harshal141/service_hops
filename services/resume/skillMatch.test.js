const { lookupNames, matchSkills } = require('./skillMatch');

describe('skill matching', () => {
  it('looks up each name and its alias target, lowercased', () => {
    expect(lookupNames(['ReactJS', 'Go'])).toEqual(['reactjs', 'react', 'go']);
  });

  it('matches exact (case-insensitive) first, then aliases; the rest are unmatched', () => {
    const rows = [{ id: 1, name: 'React' }, { id: 2, name: 'Go' }, { id: 3, name: 'Node.js' }];
    expect(matchSkills(['react.js', 'GO', 'nodejs', 'React', 'Kubernetes Operators'], rows)).toEqual({
      skills: [
        { key: 'skill-1', id: 1, name: 'React' },
        { key: 'skill-2', id: 2, name: 'Go' },
        { key: 'skill-3', id: 3, name: 'Node.js' },
      ],
      unmatched_skills: ['Kubernetes Operators'],
    });
  });
});
