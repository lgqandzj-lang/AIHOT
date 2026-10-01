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

export interface ResearchExperience {
  preview: boolean;
  papers: ResearchPaper[];
  example: ReadingExample | null;
  unavailable?: boolean;
}
