import { describe, it, expect } from 'vitest';
import {
  pageId,
  parentOf,
  decodeLabel,
  isContentLink,
  resolveLink,
  extractLinks,
  orderChildren,
  buildGraph,
  graphStats,
} from './graph';

describe('page ids and labels', () => {
  it('strips .md and finds the parent folder', () => {
    expect(pageId('Folder/Page.md')).toBe('Folder/Page');
    expect(parentOf('Folder/Page')).toBe('Folder');
    expect(parentOf('Top')).toBe('');
  });
  it('decodes the leaf and turns dashes into spaces', () => {
    expect(decodeLabel('Folder/Meeting-Recap')).toBe('Meeting Recap');
    expect(decodeLabel('%3A%3AMeeting-Journals%3A%3A')).toBe('::Meeting Journals::');
  });
  it('shows a bad percent-escape raw rather than throwing', () => {
    expect(decodeLabel('100%-done')).toBe('100% done');
  });
});

describe('link classification', () => {
  it('keeps internal page links, drops attachments and external', () => {
    expect(isContentLink('/Folder/Page')).toBe(true);
    expect(isContentLink('/.attachments/image-abc.png')).toBe(false);
    expect(isContentLink('https://example.com')).toBe(false);
    expect(isContentLink('#heading')).toBe(false);
    expect(isContentLink('relative/page')).toBe(false);
  });
  it('extracts every markdown link target', () => {
    const md = 'see [A](/Folder/A) and ![img](/.attachments/x.png) and [ext](https://y.z)';
    expect(extractLinks(md)).toEqual(['/Folder/A', '/.attachments/x.png', 'https://y.z']);
  });
});

describe('resolveLink — against the pages that exist', () => {
  const ids = new Set(['Folder/A', 'Folder/B', '%3A%3AJournals%3A%3A/Note']);
  it('resolves an internal link, dropping the leading slash, anchor and query', () => {
    expect(resolveLink('/Folder/A', ids)).toBe('Folder/A');
    expect(resolveLink('/Folder/A#section', ids)).toBe('Folder/A');
    expect(resolveLink('/Folder/A?x=1', ids)).toBe('Folder/A');
    expect(resolveLink('/Folder/A.md', ids)).toBe('Folder/A');
  });
  it('matches across encodings (a link may decode what the path stores raw)', () => {
    expect(resolveLink('/::Journals::/Note', ids)).toBe('%3A%3AJournals%3A%3A/Note');
    expect(resolveLink('/%3A%3AJournals%3A%3A/Note', ids)).toBe('%3A%3AJournals%3A%3A/Note');
  });
  it('returns undefined for a dangling link', () => {
    expect(resolveLink('/Folder/Gone', ids)).toBeUndefined();
  });
});

describe('orderChildren', () => {
  it('lists children, ignoring blanks and comments', () => {
    expect(orderChildren('A\n\nB\r\n# c\nC\n')).toEqual(['A', 'B', 'C']);
  });
});

describe('buildGraph', () => {
  const pages = [
    { path: 'Foley.md', size: 200 },
    { path: 'Foley/Standup.md', size: 500 },
    { path: 'Foley/Empty.md', size: 0 },
    { path: 'Axiplex.md', size: 300 },
  ];
  const orders = [
    { folder: '', children: ['Foley', 'Axiplex'] },
    { folder: 'Foley', children: ['Standup', 'Empty'] },
  ];
  const content = new Map<string, string>([
    ['Foley/Standup', 'notes, see [Axiplex](/Axiplex) and a [dead](/Nope) link and [img](/.attachments/y.png)'],
  ]);

  it('makes a node per page, marks the 0-byte stub, and both hierarchy and content edges', () => {
    const g = buildGraph(pages, orders, content);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['Axiplex', 'Foley', 'Foley/Empty', 'Foley/Standup']);
    expect(g.nodes.find((n) => n.id === 'Foley/Empty')!.stub).toBe(true);
    // hierarchy: Foley->Standup, Foley->Empty (top-level '' has no parent node)
    expect(g.edges.filter((e) => e.kind === 'hierarchy').map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      'Foley>Foley/Empty',
      'Foley>Foley/Standup',
    ]);
    // content: Standup -> Axiplex (the /Nope dangler and the image are dropped)
    expect(g.edges.filter((e) => e.kind === 'link')).toEqual([{ source: 'Foley/Standup', target: 'Axiplex', kind: 'link' }]);
  });

  it('degree counts both endpoints, and stats summarise', () => {
    const g = buildGraph(pages, orders, content);
    const s = graphStats(g);
    expect(s.nodes).toBe(4);
    expect(s.stubs).toBe(1);
    expect(s.hierarchy).toBe(2);
    expect(s.links).toBe(1);
    // Axiplex is reached only by the content link; Foley parents two — nobody is a true orphan here
    // except… all four are touched, so orphans is 0.
    expect(s.orphans).toBe(0);
  });

  it('never makes an edge to a page that does not exist', () => {
    const g = buildGraph(pages, orders, content);
    expect(g.edges.some((e) => e.target === 'Nope' || e.source === 'Nope')).toBe(false);
  });
});
