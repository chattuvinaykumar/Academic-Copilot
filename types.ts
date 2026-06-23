export interface SummaryResult {
  title: string;
  summary: string;
  keyPoints: string[];
  keywords: string[];
  methodologySummary?: string;
  resultsSummary?: string;
  futureWorkSummary?: string;
  limitations?: string;
  references?: string[];
}

export interface PaperFormData {
  topic: string;
  domain: string;
  keywords: string;
  problemStatement: string;
  objectives: string;
  method: string;
  dataset: string;
  paperType: string;
  publicationFormat: string;
}

export interface PaperSection {
  id: string;
  title: string;
  content: string; // Markdown
}

export interface PaperReview {
  overallScore: number;
  categoryScores: {
    novelty: number;
    technicalDepth: number;
    literatureReview: number;
    methodology: number;
    references: number;
    academicWriting: number;
    reproducibility: number;
  };
  strengths: string[];
  weaknesses: string[];
  actionableImprovements: string[];
}

export interface GeneratedPaper {
  title: string;
  abstract: string;
  keywords: string[];
  sections: PaperSection[];
  references: string;
  partial?: boolean;
  mode?: "draft" | "submission";
  version?: number;
  review?: PaperReview;
  previousVersion?: GeneratedPaper;
}

export interface ProjectFormData {
  title: string;
  domain: string;
  objectives: string;
  technologies: string;
  description: string;
  expectedOutcomes: string;
  projectType: string;
}

export interface GeneratedProject {
  title: string;
  domain: string;
  projectType: string;
  sections: PaperSection[];
  partial?: boolean;
}

export interface Draft {
  id: string;
  updatedAt: number;
  formData: PaperFormData;
  generatedPaper: GeneratedPaper | null;
}

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

