export interface ResearchPaper {
  id: string;
  title: string;
  journal: string | null;
  year: number | null;
  authors: string[];
  doi: string | null;
  pmid: string | null;
  topic: "pfa" | "rf" | "basic";
  sources: { name: string; url: string; acquiredAt: string }[];
  cohortLead?: string;
  privateDraft?: PrivateReadingDraft;
  privateResearch?: PrivateResearchEntry;
  chineseReading?: ChineseResearchReading;
}

export interface ChineseResearchReading {
  status: 'private_model_draft'; titleZh: string; leadZh: string; markdown: string; html: string; materialScope: 'fulltext';
  generatedAt: string; model: string; semanticStatus: 'not_evaluated' | 'assistant_source_comparison'; humanApprovalGranted: false;
  sources: { id: string; scope: 'abstract' | 'fulltext'; label: string; text: string; sourceUrl: string; hash: string }[];
  correctionNotes: string[];
  corrections: { field: 'markdown' | 'leadZh'; before: string; after: string; reason: string; sourceIds: string[] }[];
  license: { name: string; url: string; copyright: string; changesNotice: string };
}

export interface PrivateResearchEntry {
  recordId: string;
  readerVersion: number;
  publishedOn: string | null;
  studyType: string;
  materialScope: 'metadata' | 'abstract' | 'partial_fulltext' | 'fulltext';
  product: { id: 'varipulse'; status: 'confirmed' | 'candidate'; evidence: { label: string; quote: string; url: string }; verification?: ProductAssociationVerification };
  questions: { id: string; label: string; evidence: { label: string; quote: string; url: string } }[];
  display?: { titleZh: string; leadZh: string; curation: 'assistant_curated'; basisScope: 'title' | 'abstract'; basisUrl: string; preparedAt: string };
}

export interface ProductAssociationVerification {
  reviewer: 'assistant_source_check'; method: 'article_fulltext' | 'study_registration'; checkedAt: string; studyId: string | null; note: string;
  sources: { label: string; quote: string; url: string; location: string; acquiredAt: string; kind: 'publisher' | 'pmc' | 'pubmed' | 'official_product';
    role: 'article_device' | 'article_registration' | 'official_registration' | 'official_device'; articlePmid: string | null; articleDoi: string | null }[];
}

export interface PrivateReadingDraft {
  status: "private_auto_draft";
  reviewMethod: "assistant_source_comparison" | "not_evaluated";
  state?: "private_draft" | "degraded" | "invalid_output" | "unknown" | "unreviewed" | "index_only";
  groups: { id: string; label: string; quantity: number | null; unit: string | null; subjects: string | null; populationScope: string | null;
    evidence: { label: string; quote: string }[] }[];
  sections?: { id: string; label: string; fields: { key: string; label: string; modelValue: string;
    review: "source_supported" | "pending" | "not_reported"; note: string; evidence: { label: string; quote: string }[] }[] }[];
  sourceAbstract?: { scope: "abstract"; fullTextProvided: false; sourceName: string; sourceUrl: string; acquiredAt: string;
    fragments: { id: string; label: string | null; text: string }[] };
  readingChecks?: { formatConverted: boolean; deferredCount: number; semanticStatus: "not_evaluated" };
  readingView?: PrivateReadingView;
  diagnosticUrl?: string;
  attribution: { copyright: string; license: string; licenseUrl: string; changesNotice: string };
}

export interface ReadingValue { value: string | number | null; absence: "unknown" | "not_reported" | "not_applicable" | null }
export interface ReadingEvidence { label: string; quote: string }
export interface ReadingCount { key: string; quantity: ReadingValue; unit: ReadingValue; populationScope: ReadingValue; evidence: ReadingEvidence[] }
export interface PrivateReadingView {
  overallCounts: ReadingCount[];
  groups: { id: string; label: string; subjects: string | null; counts: ReadingCount[];
    methods: { key: string; label: string; value: string; evidence: ReadingEvidence[] }[];
    contexts: { key: string; value: string; evidence: ReadingEvidence[] }[]; evidence: ReadingEvidence[] }[];
  results: { id: string; groupId: string; kind: "duration" | "outcome"; metric: ReadingValue; resultValue: ReadingValue;
    unit: ReadingValue; statistic: ReadingValue; numerator: ReadingValue; outcomeDenominator: ReadingValue; countUnit: ReadingValue;
    windows: { key: string; value: string; evidence: ReadingEvidence[] }[]; evidence: ReadingEvidence[] }[];
  comparisons: { key: string; resultIds: string[]; description: string; evidence: ReadingEvidence[] }[];
}

export interface ReadingField {
  key: string;
  label: string;
  value: string | null;
  sourceIds: string[];
  sourceQuote?: string | null;
}

export interface ReadingExample {
  synthetic: true;
  groups: { id: string; label: string; fields: ReadingField[] }[];
  sources: { id: string; label: string; text: string }[];
}

export interface CohortCount {
  groupLabel: string;
  quantity: number;
  unit: string;
  populationScope: string;
  locator: string;
}
export interface CohortStudy {
  pmid: string;
  doi: string | null;
  title: string;
  journal: string;
  published: string;
  pubmedUrl: string;
  counts: CohortCount[];
}
export interface ResearchExperience {
  preview: boolean;
  privateProduct?: 'varipulse';
  cohortStudies?: CohortStudy[];
  catalogSource?: 'database' | 'file';
  papers: ResearchPaper[];
  example: ReadingExample | null;
  unavailable?: boolean;
  news?: PrivateNewsFeed;
  newsUnavailable?: boolean;
  readingJobs?: PrivateReadingJobs;
  readingJobsUnavailable?: boolean;
}

export interface PrivateReadingJob {
  pmid: string;
  doi: string | null;
  originalTitle: string;
  titleZh: string | null;
  readerId: string | null;
  status: 'saved' | 'ready' | 'blocked' | 'pending' | 'in_flight';
  updatedAt: string | null;
  reason: string | null;
}

export interface PrivateReadingJobs {
  private: true;
  jobs: PrivateReadingJob[];
}

export interface PrivateNewsItem {
  id: string; originalTitle: string; titleZh: string | null; leadZh: string | null;
  kind: 'paper' | 'follow_up' | 'official'; materialScope: 'title'; publishedAt: string | null; discoveredAt: string;
  historical: boolean; source: { name: string; url: string; acquiredAt: string };
  product: { id: 'varipulse'; status: 'confirmed' | 'candidate'; quote: string; url: string; method: 'source_title' | 'search_candidate' };
  researchUrl: string | null;
  relatedResearch: { recordId: string; pmid: string | null; doi: string | null; sourceReference: string; method: 'exact_identifier' } | null;
  curation: 'model_draft' | 'pending';
}
export interface PrivateNewsFeed {
  version: 'ep-private-news-v1'; private: true; items: PrivateNewsItem[]; checkedAt: string | null;
  sources: { id: string; name: string; kind: 'research' | 'official'; basisUrl: string; policyUrl: string;
    checkedAt: string | null; status: 'ok' | 'unavailable' | 'not_run'; found: number; created: number }[];
}
