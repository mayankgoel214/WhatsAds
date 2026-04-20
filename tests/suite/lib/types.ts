export interface Product {
  slug: string;                        // e.g., "diet-coke"
  name: string;                        // human-readable name
  category: string;                    // e.g., "food", "jewellery", "garment"
  expectedItemCount: number;           // 1 for single items, 3+ for sets
  photoDir: string;                    // relative to suite root, e.g. "products/diet-coke"
  photos: string[];                    // filenames, e.g. ["1.jpg", "2.jpg", "3.jpg"]
  styleTriplets: string[][];           // each inner array is exactly 3 style IDs sent per API call
  instructions: InstructionCase[];     // instruction variants to test
  notes?: string;                      // human notes about this product
}

export interface InstructionCase {
  case: string;                        // short label, e.g., "no-instruction", "global-pink-bg"
  text: string | null;                 // null = no instruction
}

export interface Manifest {
  config: {
    adminUrl: string;                  // e.g., "http://localhost:3001"
    adminKey: string;                  // the ADMIN_SECRET value
    runsPerCombo: number;              // how many times to run each combination (default 1)
    parallelism: number;               // max concurrent requests (default 3)
    retries: number;                   // retries per failed test (default 1)
  };
  products: Product[];
}

export interface TestCombination {
  productSlug: string;
  stylesTriplet: string[];             // admin API takes exactly 3 styles per call
  instructionCase: InstructionCase;
  runNumber: number;
}

export interface TestResult {
  // Identifiers
  product: string;
  style: string;
  instructionCase: string;
  runNumber: number;
  timestamp: string;                   // ISO 8601

  // Pipeline output
  qaScore: number | null;
  tier: number | null;
  pipeline: string | null;
  durationMs: number | null;

  // Files & URLs
  outputLocalPath: string | null;
  outputUrl: string | null;

  // Prompt sent to Gemini
  prompt: string | null;

  // Analysis from lightAnalyze
  analysis: AnalysisResult | null;

  // Error (if test failed)
  error: string | null;
  errorAttempts: number;               // number of times we retried
}

export interface AnalysisResult {
  productName: string;
  productCategory: string;
  hasBranding: boolean;
  physicalSize: string;
  dominantColors: string[];
  typicalSetting: string;
  usable: boolean;
  itemCount: number;
  items: string[];
  setDescription: string | null;
  analyzerFellBack: boolean;           // true if productName === "product" (silent fallback detection)
}

export interface GradeEntry {
  // Must match result row identity
  product: string;
  style: string;
  instructionCase: string;
  runNumber: number;

  // 5-dimension scores (0-100, null if not graded)
  productAccuracy: number | null;
  brandPreservation: number | null;
  styleMatch: number | null;
  adQuality: number | null;
  creativity: number | null;

  // Computed
  weightedTotal: number | null;        // per weighting rule in manifest
  letterGrade: string | null;          // A+/A/A-/B+/B/B-/C+/C/C-/D/F

  // Failure modes (comma-separated enum)
  failureModes: string;                // e.g., "TEXT_HALLUCINATED,ANGLE_WRONG"

  // Notes
  observations: string;
}

export const FAILURE_MODES = [
  'PRODUCT_DISAPPEARED',
  'PRODUCT_DAMAGED',
  'PRODUCT_RECOLORED',
  'PIECE_MISSING',
  'TEXT_HALLUCINATED',
  'BRAND_INCORRECT',
  'ANGLE_WRONG',
  'CULTURALLY_OFF',
  'STYLE_MISMATCH',
  'SCALE_WRONG',
  'BACKGROUND_ONLY',
  'CLICHE_DEFAULT',
  'ANALYZER_FALLBACK',
] as const;

export type FailureMode = typeof FAILURE_MODES[number];

// Weighting for computing weighted total grade
// Different weights for Autmn Special (creativity weighted higher)
export function computeWeightedTotal(grade: GradeEntry, style: string): number | null {
  const { productAccuracy, brandPreservation, styleMatch, adQuality, creativity } = grade;
  if ([productAccuracy, brandPreservation, styleMatch, adQuality, creativity].some(v => v === null)) {
    return null;
  }
  const weights = style === 'style_autmn_special'
    ? { prodAcc: 0.25, brand: 0.10, styleMatch: 0.15, adQual: 0.15, creativity: 0.35 }
    : { prodAcc: 0.30, brand: 0.20, styleMatch: 0.20, adQual: 0.20, creativity: 0.10 };
  return (
    productAccuracy! * weights.prodAcc +
    brandPreservation! * weights.brand +
    styleMatch! * weights.styleMatch +
    adQuality! * weights.adQual +
    creativity! * weights.creativity
  );
}

export function scoreToLetter(score: number): string {
  if (score >= 93) return 'A+';
  if (score >= 87) return 'A';
  if (score >= 83) return 'A-';
  if (score >= 77) return 'B+';
  if (score >= 73) return 'B';
  if (score >= 67) return 'B-';
  if (score >= 63) return 'C+';
  if (score >= 57) return 'C';
  if (score >= 53) return 'C-';
  if (score >= 45) return 'D';
  return 'F';
}
