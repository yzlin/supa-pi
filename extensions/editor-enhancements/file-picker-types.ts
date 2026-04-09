export interface FileEntry {
  name: string;
  isDirectory: boolean;
  relativePath: string;
}

export type TabCompletionMode = "segment" | "bestMatch";

export interface PickerState {
  respectGitignore: boolean;
  skipHidden: boolean;
  allowFolderSelection: boolean;
}

export interface PickerConfig {
  respectGitignore?: boolean;
  skipHidden?: boolean;
  allowFolderSelection?: boolean;
  skipPatterns?: string[];
  tabCompletionMode?: TabCompletionMode;
}

export interface PickerRuntimeConfig {
  respectGitignore: boolean;
  skipHidden: boolean;
  allowFolderSelection: boolean;
  skipPatterns: string[];
  tabCompletionMode: TabCompletionMode;
}

export interface BrowserOption {
  id: string;
  label: string;
  enabled: boolean;
  visible: () => boolean;
}

export interface SelectedPath {
  path: string;
  isDirectory: boolean;
}

export interface CompletionEntry {
  path: string;
  isDirectory: boolean;
}

export type FileBrowserAction =
  | { action: "confirm"; paths: SelectedPath[] }
  | { action: "cancel" }
  | { action: "select"; selected: SelectedPath; paths: SelectedPath[] };
