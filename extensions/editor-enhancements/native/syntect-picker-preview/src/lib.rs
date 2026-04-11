#![allow(non_snake_case)]

use std::io::Cursor;
use std::path::Path;
use std::sync::LazyLock;

use napi_derive::napi;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::as_24_bit_terminal_escaped;

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);
static BAT_THEME_DARK: LazyLock<Theme> =
    LazyLock::new(|| load_embedded_theme(include_bytes!("../themes/Monokai Extended.tmTheme")));
static BAT_THEME_LIGHT: LazyLock<Theme> = LazyLock::new(|| {
    load_embedded_theme(include_bytes!("../themes/Monokai Extended Light.tmTheme"))
});

#[allow(non_snake_case)]
#[napi(object)]
pub struct HighlightPreviewInput {
    pub code: String,
    pub filePath: Option<String>,
    pub themeMode: Option<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
pub struct HighlightPreviewResult {
    pub lines: Vec<String>,
    pub language: Option<String>,
    pub usedPlaintext: bool,
}

#[napi(js_name = "highlightPreview")]
pub fn highlight_preview(input: HighlightPreviewInput) -> HighlightPreviewResult {
    let syntax = resolve_syntax(input.filePath.as_deref());
    let syntax_name = syntax.name.clone();
    let used_plaintext = syntax_name == "Plain Text";
    let theme = resolve_theme(input.themeMode.as_deref());

    HighlightPreviewResult {
        lines: if used_plaintext {
            input.code.split('\n').map(str::to_string).collect()
        } else {
            highlight_ansi_lines(&input.code, syntax, theme)
        },
        language: Some(syntax_name),
        usedPlaintext: used_plaintext,
    }
}

fn highlight_ansi_lines(code: &str, syntax: &SyntaxReference, theme: &Theme) -> Vec<String> {
    let raw_lines: Vec<&str> = code.split('\n').collect();
    let mut highlighter = HighlightLines::new(syntax, theme);

    raw_lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let mut source = (*line).to_string();
            if index + 1 < raw_lines.len() {
                source.push('\n');
            }

            match highlighter.highlight_line(&source, &SYNTAX_SET) {
                Ok(ranges) => as_24_bit_terminal_escaped(&ranges[..], false)
                    .trim_end_matches('\n')
                    .to_string(),
                Err(_) => (*line).to_string(),
            }
        })
        .collect()
}

fn resolve_syntax(file_path: Option<&str>) -> &'static SyntaxReference {
    if let Some(path) = file_path {
        if let Some(extension) = Path::new(path).extension().and_then(|ext| ext.to_str()) {
            let normalized_extension = extension.to_ascii_lowercase();

            if let Some(alias) = aliased_extension(&normalized_extension) {
                if let Some(syntax) = SYNTAX_SET
                    .find_syntax_by_extension(alias)
                    .or_else(|| SYNTAX_SET.find_syntax_by_token(alias))
                {
                    return syntax;
                }
            }

            if let Some(syntax) = SYNTAX_SET
                .find_syntax_by_extension(&normalized_extension)
                .or_else(|| SYNTAX_SET.find_syntax_by_token(&normalized_extension))
            {
                return syntax;
            }
        }
    }

    SYNTAX_SET.find_syntax_plain_text()
}

fn aliased_extension(extension: &str) -> Option<&'static str> {
    match extension {
        // syntect's default dump doesn't ship TypeScript/TSX grammars, so use
        // JavaScript as the closest built-in approximation instead of dropping
        // straight to plain text.
        "ts" | "mts" | "cts" | "tsx" => Some("js"),
        _ => None,
    }
}

fn resolve_theme(theme_mode: Option<&str>) -> &'static Theme {
    match theme_mode {
        Some("light") => &BAT_THEME_LIGHT,
        _ => &BAT_THEME_DARK,
    }
}

fn load_embedded_theme(theme_bytes: &[u8]) -> Theme {
    let mut cursor = Cursor::new(theme_bytes);
    ThemeSet::load_from_reader(&mut cursor)
        .expect("embedded bat theme should always parse successfully")
}

#[cfg(test)]
mod tests {
    use super::{highlight_preview, resolve_theme, HighlightPreviewInput};

    #[test]
    fn highlights_known_extensions_without_losing_line_count() {
        let result = highlight_preview(HighlightPreviewInput {
            code: "fn answer() -> u64 {\n    42\n}\n".to_string(),
            filePath: Some("example.rs".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert_eq!(result.lines.len(), 4);
        assert_eq!(result.language.as_deref(), Some("Rust"));
        assert!(!result.usedPlaintext);
        assert!(result.lines[0].contains("\u{1b}["));
        assert!(!result.lines[0].contains("\u{1b}[48;2;"));
    }

    #[test]
    fn aliases_typescript_extensions_to_javascript() {
        let result = highlight_preview(HighlightPreviewInput {
            code: "const answer: number = 42;\nexport default answer;\n".to_string(),
            filePath: Some("example.ts".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert_eq!(result.lines.len(), 3);
        assert_eq!(result.language.as_deref(), Some("JavaScript"));
        assert!(!result.usedPlaintext);
        assert!(result.lines[0].contains("\u{1b}["));
    }

    #[test]
    fn uses_bat_default_theme_names() {
        assert_eq!(resolve_theme(Some("dark")).name.as_deref(), Some("Monokai Extended"));
        assert_eq!(
            resolve_theme(Some("light")).name.as_deref(),
            Some("Monokai Extended Light")
        );
    }

    #[test]
    fn falls_back_to_plain_text_when_extension_is_unknown() {
        let result = highlight_preview(HighlightPreviewInput {
            code: "plain text".to_string(),
            filePath: Some("notes.unknown".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert_eq!(result.language.as_deref(), Some("Plain Text"));
        assert!(result.usedPlaintext);
        assert_eq!(result.lines, vec!["plain text".to_string()]);
    }
}
