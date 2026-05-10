export type Severity = 'block' | 'high' | 'medium' | 'low';
export type Category = 'bug' | 'security' | 'performance' | 'maintainability' | 'convention';

export interface Issue {
  file: string;
  line_start: number;
  line_end: number;
  category: Category;
  severity: Severity;
  title: string;
  why: string;
  suggestion?: string;
}

export interface Review {
  summary: string;
  estimated_review_effort_1_to_5: number;
  issues: Issue[];
  security_concerns: string;
  test_coverage_assessment: string;
}

export interface PromptLayer {
  id: string;
  description?: string;
  extends: string[];
  body: string;
  source: string;
}

export interface ReviewConfig {
  /** Resolved leaf prompt IDs to load, e.g. ["python/+fastapi"]. */
  layers: string[];
  /** Optional path to a project-level overlay (Layer 3) markdown file. */
  projectRulesPath?: string;
  /** Anthropic model id. */
  model: string;
  /** Max tokens to allow in the model's response. */
  maxTokens: number;
}
