// SYNTHETIC TEST RECORD ONLY. Authored values, never a repaired paper/model answer.
import { randomUUID } from 'node:crypto';
import { inputFingerprint } from '../../packages/backend/src/research/normalize.ts';
import type { AbstractMaterialBundle } from '../../packages/backend/src/research/abstract-evidence.ts';

export const structuredSyntheticText = '[SYNTHETIC TEST RECORD ONLY] Overall, 22 participants and 88 pulmonary veins were studied. '
  + 'Group Alpha enrolled 9 participants and studied 36 pulmonary veins; Group Beta enrolled 13 participants and studied 52 pulmonary veins. These are reported group counts, not result denominators. '
  + 'Group Alpha had median procedural duration 48 minutes; Group Beta had median procedural duration 26 minutes. The source explicitly compared these two medians. '
  + 'Group Alpha success was 78.4 percent at 12 months after the procedure; the numerator and assessed denominator were not reported. '
  + 'A mapping stage before ablation was described for Group Alpha.';

export function structuredExtractionFixture(text = structuredSyntheticText) {
  const materialId = randomUUID(), materialHash = inputFingerprint({ synthetic: text });
  const fragment = { id: randomUUID(), materialId, materialHash, splitRuleVersion: 'abstract-source-v1', ordinal: 1,
    sectionLabel: 'Synthetic test record', scope: 'abstract' as const, text,
    fragmentHash: inputFingerprint({ scope: 'abstract', sectionLabel: 'Synthetic test record', text }) };
  const bundle: AbstractMaterialBundle = { id: randomUUID(), materialId, materialHash, splitRuleVersion: fragment.splitRuleVersion,
    state: 'ready', scope: 'abstract', source: { provider: 'synthetic', providerId: 'TEST-STRUCTURE-V4', sourceUrl: 'https://example.org/test-only',
      acquiredAt: '2026-10-01T00:00:00Z', versionLabel: 'SYNTHETIC TEST ONLY' }, fragments: [fragment], providedFragmentIds: [fragment.id],
    fullTextProvided: false, processingAuthorization: 'not_evaluated', citationValidation: 'identity_only' };
  const cite = <V>(value: V) => ({ value, citations: [fragment.id] as string[] });
  const absent = (status: 'unknown' | 'not_reported' = 'not_reported') => ({ value: null, citations: [], status });
  const sample = (quantity: number, unit: string, denominator: string) => ({ quantity: cite(quantity), unit: cite(unit), denominator: cite(denominator) });
  const group = (groupId: string, name: string, quantity: number, veins: number) => ({ groupId, groupLabel: cite(name), researchSubjects: cite('participants'),
    productRoles: absent(), sample: [sample(quantity, 'participants', name + ' enrolled participants'),
      sample(veins, 'pulmonary veins', name + ' studied pulmonary veins')], imagingMethods: absent(), radiationStrategy: absent() });
  const duration = (resultId: string, groupId: string, value: number) => ({ resultId, kind: 'duration', population: cite({ scope: 'group', groupId }),
    metric: cite('procedural duration'), resultValue: cite(value), unit: cite('minutes'), statistic: cite('median'),
    numerator: absent(), outcomeDenominator: absent(), countUnit: absent() });
  const output = {
    overallSample: [sample(22, 'participants', 'all studied participants'), sample(88, 'pulmonary veins', 'all studied pulmonary veins')],
    groups: [group('g1', 'Group Alpha', 9, 36), group('g2', 'Group Beta', 13, 52)],
    results: [duration('r1', 'g1', 48), duration('r2', 'g2', 26), { resultId: 'r3', kind: 'outcome', population: cite({ scope: 'group', groupId: 'g1' }),
      metric: cite('success'), resultValue: cite(78.4), unit: cite('%'), statistic: absent(), numerator: absent(), outcomeDenominator: absent(), countUnit: absent() }],
    comparisons: [{ resultIds: cite(['r1', 'r2']), description: cite('explicit comparison of the Group Alpha and Group Beta procedural-duration medians') }],
    proceduralContexts: [{ kind: 'procedural_stage', population: cite({ scope: 'group', groupId: 'g1' }), stage: cite('mapping before ablation') }],
    observationTimes: [{ resultId: 'r3', time: cite({ kind: 'observation_window', start: 12, end: 12, unit: 'months', anchor: cite('after the procedure') }) }],
  };
  return { bundle, output, cite, absent, sample, duration };
}

export function ambiguousStructuredFixture() {
  const fixture = structuredExtractionFixture('[SYNTHETIC TEST RECORD ONLY] Groups Alpha and Beta were described. '
    + 'Durations 17 and 29 minutes were listed; group ownership and statistical summaries were not stated.');
  const { output, absent, cite } = fixture;
  return { ...fixture, output: {
    ...output, overallSample: absent(),
    groups: output.groups.map(group => ({ ...group, sample: absent(), researchSubjects: absent() })),
    results: output.results.slice(0, 2).map((result, index) => ({ ...result,
      population: absent('unknown'), resultValue: cite(index === 0 ? 17 : 29), statistic: absent() })),
    comparisons: absent('unknown'), observationTimes: absent(), proceduralContexts: absent(),
  } };
}
