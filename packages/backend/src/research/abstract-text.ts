import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ResearchValidationError } from './contracts.ts';

export interface AbstractSection { label: string | null; text: string }
type Node = Record<string, unknown>;
const localName = (name: string) => name.split(':').at(-1)!.toLowerCase();
const children = (value: unknown): Node[] => Array.isArray(value) ? value as Node[] : [];
const tag = (node: Node): string | undefined => Object.keys(node).find(key => key !== ':@' && key !== '#text');
const normalizeText = (text: string): string => text.replace(/\r\n?/g, '\n')
  .split('\n').map(line => line.replace(/[^\S\n]+/gu, ' ').trim()).join('\n').trim();

function parseOrdered(xml: string): Node[] {
  // External DTD declarations (including PubMed's standard declaration) are
  // ignored, never fetched. Internal entity definitions are not accepted.
  xml = xml.replace(/<!DOCTYPE[^<>\[\]]*>/gi, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new ResearchValidationError('Abstract XML declarations are unsupported.');
  if (XMLValidator.validate(xml) !== true) throw new ResearchValidationError('Invalid abstract XML.');
  return children(new XMLParser({ preserveOrder: true, ignoreAttributes: false,
    parseTagValue: false, trimValues: false, htmlEntities: true }).parse(xml));
}
// Concatenate mixed inline nodes in source order. Do not insert spaces around
// superscripts, emphasis or numbers: those spaces may change a unit or value.
function textOf(nodes: Node[]): string {
  return nodes.map(node => {
    if ('#text' in node) return String(node['#text']);
    const name = tag(node);
    if (!name) return '';
    if (localName(name) === 'br') return '\n';
    const text = textOf(children(node[name]));
    // Explicit source notation prevents 10<sup>-3</sup> becoming the
    // subtraction-like "10-3", and preserves subscripts in chemical units.
    if (localName(name) === 'sup') return '^(' + text.trim() + ')';
    if (localName(name) === 'sub') return '_(' + text.trim() + ')';
    return localName(name) === 'p' ? '\n\n' + text + '\n\n' : text;
  }).join('');
}
function atPath(nodes: Node[], path: string[]): Node[] {
  if (!path.length) return nodes;
  return nodes.flatMap(node => {
    const name = tag(node);
    return name && localName(name) === path[0]
      ? atPath(children(node[name]), path.slice(1)) : [];
  });
}
export function renderAbstractSections(sections: AbstractSection[]): string {
  return sections.map(section => (section.label ? section.label + ': ' : '') + section.text).join('\n');
}

/** Only Article.Abstract.AbstractText; not OtherAbstract, body or full text. */
export function pubmedAbstractSections(xml: string): AbstractSection[] {
  const nodes = atPath(parseOrdered(xml), ['pubmedarticleset', 'pubmedarticle',
    'medlinecitation', 'article', 'abstract']);
  return nodes.flatMap(node => {
    const name = tag(node);
    if (!name || localName(name) !== 'abstracttext') return [];
    const attrs = node[':@'] as Record<string, unknown> | undefined;
    const text = normalizeText(textOf(children(node[name])));
    const sourceLabel = typeof attrs?.['@_Label'] === 'string' ? attrs['@_Label'].trim() : '';
    const category = typeof attrs?.['@_NlmCategory'] === 'string' ? attrs['@_NlmCategory'].trim() : '';
    const label = sourceLabel || (category.toUpperCase() !== 'UNASSIGNED' ? category : '') || null;
    return text ? [{ label, text }] : [];
  });
}

/** Keep source section titles and paragraphs; every output is still abstract text. */
export function jatsAbstractSections(xml: string): AbstractSection[] {
  const result: AbstractSection[] = [];
  function add(text: string, label: string | null): void {
    for (const paragraph of normalizeText(text).split(/\n\s*\n/)) {
      if (paragraph.trim()) result.push({ label, text: paragraph.trim() });
    }
  }
  function visit(nodes: Node[], label: string | null): void {
    let inline = '';
    const flush = () => { add(inline, label); inline = ''; };
    for (const node of nodes) {
      if ('#text' in node) { inline += String(node['#text']); continue; }
      const name = tag(node);
      if (!name) continue;
      const kind = localName(name);
      const nested = children(node[name]);
      if (kind === 'sec') {
        flush();
        const title = nested.find(child => { const key = tag(child); return key && localName(key) === 'title'; });
        const attrs = node[':@'] as Record<string, unknown> | undefined;
        const sourceType = typeof attrs?.['@_sec-type'] === 'string' ? attrs['@_sec-type'].trim() || null : null;
        const sectionLabel = title ? normalizeText(textOf([title])) || sourceType || label : sourceType || label;
        visit(nested.filter(child => child !== title), sectionLabel);
      } else if (kind === 'p') {
        flush(); add(textOf(nested), label);
      } else if (kind === 'abstract') {
        flush(); visit(nested, label);
      } else inline += textOf([node]);
    }
    flush();
  }
  // A wrapper also permits provider fragments containing multiple sibling <p>s.
  visit(parseOrdered('<abstract>' + xml + '</abstract>'), null);
  return result;
}

const legacyLabel = /^(Background|Objectives?|Aims?|Methods?|Materials and Methods|Results?|Conclusions?|Purpose|Design|Setting|Participants|Interventions|Measurements)\s*:/i;
export function plainAbstractSections(text: string): AbstractSection[] {
  // Only treat a single newline as a section boundary when it introduces a
  // recognizable legacy source label. Otherwise preserve the stored paragraph.
  const sections: AbstractSection[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    let current = '';
    for (const line of paragraph.split('\n')) {
      if (legacyLabel.test(line.trim()) && current.trim()) {
        const label = legacyLabel.exec(current.trim())?.[1] ?? null;
        sections.push({ label, text: current.trim() }); current = '';
      }
      current += (current ? '\n' : '') + line;
    }
    if (current.trim()) sections.push({ label: legacyLabel.exec(current.trim())?.[1] ?? null, text: current.trim() });
  }
  return sections;
}

export function splitAbstractText(metadata: {
  abstract: string | null; abstractFormat: 'plain' | 'jats' | null; abstractSections?: AbstractSection[];
}): AbstractSection[] {
  if (!metadata.abstract) return [];
  if (metadata.abstractSections) return metadata.abstractSections.flatMap(section =>
    section.text.split(/\n\s*\n/).filter(text => text.trim()).map(text => ({ label: section.label, text: text.trim() })));
  return metadata.abstractFormat === 'jats'
    ? jatsAbstractSections(metadata.abstract) : plainAbstractSections(metadata.abstract);
}
