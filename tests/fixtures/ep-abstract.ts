// Entirely synthetic. These sentences and numbers are not from any paper.
import type { LiteratureMetadata } from '../../packages/backend/src/research/metadata.ts';

export const structuredAbstract = `<jats:abstract>
  <jats:sec><jats:title>Methods</jats:title><jats:p>No <jats:italic>sample</jats:italic> received &#x2265;5&nbsp;mg; 2 mm preceded <jats:bold>3</jats:bold> mm.</jats:p></jats:sec>
  <jats:sec><jats:title>Results</jats:title><jats:p>10% did <jats:bold>not</jats:bold> change; 7 ms was not 8 ms &amp; no value was inferred.</jats:p></jats:sec>
</jats:abstract>`;
export const methodsText = 'No sample received ≥5 mg; 2 mm preceded 3 mm.';
export const resultsText = '10% did not change; 7 ms was not 8 ms & no value was inferred.';
export function abstractMetadata(doi: string, abstract: string | null,
  format: 'plain' | 'jats' | null = abstract ? 'plain' : null,
  overrides: Partial<LiteratureMetadata> = {},
): LiteratureMetadata {
  return { provider: 'crossref', providerId: doi,
    sourceUrl: 'https://api.crossref.org/works/' + encodeURIComponent(doi),
    acquiredAt: '2026-09-30T14:00:00.000Z', doi, pmid: null,
    title: '[SYNTHETIC] Abstract evidence fixture', authors: ['Test Author'], journal: 'Fixture Journal',
    publishedYear: null, publishedOn: null, abstract, abstractFormat: format,
    abstractLocator: abstract ? 'Crossref:message.abstract' : null, versionLabel: 'synthetic-v1', ...overrides };
}
