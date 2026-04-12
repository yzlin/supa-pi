export interface HighlightPreviewInput {
  code: string;
  filePath?: string | null;
  themeMode?: "dark" | "light" | null;
}

export interface HighlightPreviewResult {
  lines: string[];
  language?: string | null;
  usedPlaintext: boolean;
}

export interface NativeHighlightBinding {
  highlightPreview(input: HighlightPreviewInput): HighlightPreviewResult;
}

export function getNativeBinding(): NativeHighlightBinding | null;
export function getNativeBindingStatus(): {
  attempted: boolean;
  error: Error | null;
  loaded: boolean;
};
