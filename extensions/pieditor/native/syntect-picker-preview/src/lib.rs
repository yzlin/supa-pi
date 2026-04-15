#![allow(non_snake_case)]

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use bat::{assets::HighlightingAssets, SyntaxMapping};
use napi_derive::napi;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Style, Theme};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

const BAT_THEME_DARK: &str = "Monokai Extended";
const BAT_THEME_LIGHT: &str = "Monokai Extended Light";

static HIGHLIGHTING_ASSETS: LazyLock<Mutex<HighlightingAssets>> =
    LazyLock::new(|| Mutex::new(HighlightingAssets::from_binary()));

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
    let assets = HIGHLIGHTING_ASSETS
        .lock()
        .expect("highlighting assets mutex should not be poisoned");
    let (syntax_set, syntax) = resolve_syntax(&assets, input.filePath.as_deref());
    let syntax_name = syntax.name.clone();
    let used_plaintext = syntax_name == "Plain Text";
    let theme = resolve_theme(&assets, input.themeMode.as_deref());

    HighlightPreviewResult {
        lines: if used_plaintext {
            input.code.split('\n').map(str::to_string).collect()
        } else {
            highlight_ansi_lines(&input.code, syntax_set, syntax, theme)
        },
        language: Some(syntax_name),
        usedPlaintext: used_plaintext,
    }
}

fn highlight_ansi_lines(
    code: &str,
    syntax_set: &SyntaxSet,
    syntax: &SyntaxReference,
    theme: &Theme,
) -> Vec<String> {
    let mut highlighter = HighlightLines::new(syntax, theme);

    LinesWithEndings::from(code)
        .map(|line| match highlighter.highlight_line(line, syntax_set) {
            Ok(ranges) => format_bat_style_ranges(&trim_trailing_newline_range(&ranges)),
            Err(_) => line.strip_suffix('\n').unwrap_or(line).to_string(),
        })
        .collect()
}

fn format_bat_style_ranges(ranges: &[(Style, &str)]) -> String {
    let mut escaped = String::new();

    for (style, text) in ranges {
        if text.is_empty() {
            continue;
        }

        if let Some(prefix) = foreground_escape(*style) {
            escaped.push_str(&prefix);
            escaped.push_str(text);
            escaped.push_str("\u{1b}[0m");
        } else {
            escaped.push_str(text);
        }
    }

    escaped
}

fn foreground_escape(style: Style) -> Option<String> {
    match style.foreground.a {
        0 => match style.foreground.r {
            0x00 => Some("\u{1b}[30m".to_string()),
            0x01 => Some("\u{1b}[31m".to_string()),
            0x02 => Some("\u{1b}[32m".to_string()),
            0x03 => Some("\u{1b}[33m".to_string()),
            0x04 => Some("\u{1b}[34m".to_string()),
            0x05 => Some("\u{1b}[35m".to_string()),
            0x06 => Some("\u{1b}[36m".to_string()),
            0x07 => Some("\u{1b}[37m".to_string()),
            value => Some(format!("\u{1b}[38;5;{value}m")),
        },
        1 => None,
        _ => Some(format!(
            "\u{1b}[38;2;{};{};{}m",
            style.foreground.r, style.foreground.g, style.foreground.b
        )),
    }
}

fn trim_trailing_newline_range<'a>(ranges: &[(Style, &'a str)]) -> Vec<(Style, &'a str)> {
    let mut trimmed_ranges = ranges.to_vec();

    if let Some((_, text)) = trimmed_ranges.last_mut() {
        if *text == "\n" {
            trimmed_ranges.pop();
        } else if let Some(without_newline) = text.strip_suffix('\n') {
            *text = without_newline;
        }
    }

    trimmed_ranges
}

fn resolve_syntax<'a>(
    assets: &'a HighlightingAssets,
    file_path: Option<&str>,
) -> (&'a SyntaxSet, &'a SyntaxReference) {
    let syntax_set = assets
        .get_syntax_set()
        .expect("bat compiled syntax set should always deserialize successfully");
    let syntax_mapping = SyntaxMapping::new();

    let syntax = file_path
        .map(Path::new)
        .and_then(|path| assets.get_syntax_for_path(path, &syntax_mapping).ok())
        .map(|syntax_in_set| syntax_in_set.syntax)
        .unwrap_or_else(|| syntax_set.find_syntax_plain_text());

    (syntax_set, syntax)
}

fn resolve_theme<'a>(assets: &'a HighlightingAssets, theme_mode: Option<&str>) -> &'a Theme {
    match theme_mode {
        Some("light") => assets.get_theme(BAT_THEME_LIGHT),
        _ => assets.get_theme(BAT_THEME_DARK),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command};

    use bat::{assets::HighlightingAssets, SyntaxMapping};

    use super::{
        highlight_ansi_lines, highlight_preview, HighlightPreviewInput, BAT_THEME_DARK,
        BAT_THEME_LIGHT,
    };

    fn expected_bat_lines(code: &str, file_path: &str, theme_mode: &str) -> Vec<String> {
        let assets = HighlightingAssets::from_binary();
        let syntax_mapping = SyntaxMapping::new();
        let syntax_in_set = assets
            .get_syntax_for_path(file_path, &syntax_mapping)
            .expect("bat should detect syntax for the fixture path");
        let theme = match theme_mode {
            "light" => assets.get_theme(BAT_THEME_LIGHT),
            _ => assets.get_theme(BAT_THEME_DARK),
        };

        highlight_ansi_lines(code, syntax_in_set.syntax_set, syntax_in_set.syntax, theme)
    }

    fn bat_cli_lines(code: &str, file_path: &str, theme_name: &str) -> Vec<String> {
        let fixture_path = std::env::temp_dir().join(format!(
            "syntect-picker-preview-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos(),
            file_path,
        ));
        fs::write(&fixture_path, code).expect("temporary bat fixture should be writable");

        let output = Command::new("bat")
            .args([
                "--paging=never",
                "--style=plain",
                "--color=always",
                "--theme",
                theme_name,
                "--file-name",
                file_path,
            ])
            .arg(&fixture_path)
            .output()
            .expect("bat should be installed for CLI parity tests");

        let _ = fs::remove_file(&fixture_path);

        assert!(
            output.status.success(),
            "bat command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        String::from_utf8(output.stdout)
            .expect("bat stdout should be utf-8")
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn highlights_known_extensions_without_losing_line_count() {
        let result = highlight_preview(HighlightPreviewInput {
            code: "fn answer() -> u64 {\n    42\n}\n".to_string(),
            filePath: Some("example.rs".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert_eq!(result.lines.len(), 3);
        assert_eq!(result.language.as_deref(), Some("Rust"));
        assert!(!result.usedPlaintext);
        assert!(result.lines[0].contains("\u{1b}["));
        assert!(!result.lines[0].contains("\u{1b}[48;2;"));
    }

    #[test]
    fn detects_typescript_with_bat_assets() {
        let result = highlight_preview(HighlightPreviewInput {
            code: "const answer: number = 42;\nexport default answer;\n".to_string(),
            filePath: Some("example.ts".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert_eq!(
            result.lines,
            expected_bat_lines(
                "const answer: number = 42;\nexport default answer;\n",
                "example.ts",
                "dark",
            )
        );
        assert_eq!(result.language.as_deref(), Some("TypeScript"));
        assert!(!result.usedPlaintext);
    }

    #[test]
    fn matches_bat_highlighting_for_javascript_files() {
        let code = "const answer = 42;\nexport default answer;\n";
        let result = highlight_preview(HighlightPreviewInput {
            code: code.to_string(),
            filePath: Some("example.js".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert!(matches!(
            result.language.as_deref(),
            Some(language) if language.contains("JavaScript")
        ));
        assert!(!result.usedPlaintext);
        assert_eq!(result.lines, expected_bat_lines(code, "example.js", "dark"));
    }

    #[test]
    fn uses_bat_compiled_theme_names() {
        let assets = HighlightingAssets::from_binary();

        assert_eq!(
            assets.get_theme(BAT_THEME_DARK).name.as_deref(),
            Some(BAT_THEME_DARK)
        );
        assert_eq!(
            assets.get_theme(BAT_THEME_LIGHT).name.as_deref(),
            Some(BAT_THEME_LIGHT)
        );
    }

    #[test]
    fn matches_bat_highlighting_for_package_json() {
        let mut code =
            fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("package.json"))
                .expect("package.json fixture should be readable");
        if !code.ends_with('\n') {
            code.push('\n');
        }

        let result = highlight_preview(HighlightPreviewInput {
            code: code.clone(),
            filePath: Some("package.json".to_string()),
            themeMode: Some("dark".to_string()),
        });

        assert!(code.ends_with('\n'));
        assert_eq!(result.language.as_deref(), Some("JSON"));
        assert!(!result.usedPlaintext);
        assert_eq!(
            result.lines,
            bat_cli_lines(&code, "package.json", BAT_THEME_DARK)
        );
    }

    #[test]
    fn matches_bat_highlighting_for_json_files() {
        let code = "{\n  \"name\": \"supa-pi\",\n  \"enabled\": true\n}\n";
        let result = highlight_preview(HighlightPreviewInput {
            code: code.to_string(),
            filePath: Some("config.json".to_string()),
            themeMode: Some("light".to_string()),
        });

        assert_eq!(result.language.as_deref(), Some("JSON"));
        assert!(!result.usedPlaintext);
        assert_eq!(
            result.lines,
            expected_bat_lines(code, "config.json", "light")
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
