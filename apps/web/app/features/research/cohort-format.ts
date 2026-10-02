import type { CohortStudy } from './contracts.ts';

const UNITS: Record<string, string> = {
  patients: '名患者',
  trials: '次',
  'pulmonary veins': '条肺静脉',
};

export function formatCohortCount(quantity: number, unit: string): string {
  return `${quantity} ${UNITS[unit] || unit}`;
}

export function leadCohortCount(study: CohortStudy): string {
  const count = study.counts.find(item => item.groupLabel === 'enrolled') || study.counts[0];
  return count ? formatCohortCount(count.quantity, count.unit) : '摘要未写人数';
}
