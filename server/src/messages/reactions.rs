use serde::Deserialize;

const EMOJI_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../contract/reactions/emoji.json"
));
const MAX_EMOJI_BYTES: usize = 32;

pub struct ReactionEmojiSet {
    emoji: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    emoji: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    emoji: String,
    label: String,
}

impl ReactionEmojiSet {
    pub fn load_embedded() -> Result<Self, String> {
        Self::parse(EMOJI_JSON)
            .map_err(|error| format!("Invalid contract/reactions/emoji.json: {error}"))
    }

    fn parse(json: &str) -> Result<Self, String> {
        let catalog: Catalog = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if catalog.version != 1 {
            return Err(format!("expected version 1, got {}", catalog.version));
        }
        if catalog.emoji.is_empty() {
            return Err("emoji list must be nonempty".into());
        }

        let mut set = Self {
            emoji: Vec::with_capacity(catalog.emoji.len()),
        };
        for (index, Entry { emoji, label }) in catalog.emoji.into_iter().enumerate() {
            let error = if emoji.is_empty() {
                "emoji must be nonempty"
            } else if emoji.len() > MAX_EMOJI_BYTES {
                "emoji exceeds 32 UTF-8 bytes"
            } else if emoji.is_ascii() {
                "emoji must not be plain ASCII"
            } else if emoji.starts_with(['\u{200d}', '\u{fe0f}']) || emoji.ends_with('\u{200d}') {
                "emoji joiner or variation selector has no adjacent base"
            } else if emoji.chars().any(|ch| {
                ch.is_whitespace() || ch.is_control() || (ch != '\u{200d}' && is_format(ch))
            }) {
                "emoji contains whitespace, a control, or a disallowed format character"
            } else if label.is_empty() {
                "label must be nonempty"
            } else if set.contains(&emoji) {
                "duplicate emoji"
            } else {
                set.emoji.push(emoji);
                continue;
            };
            return Err(format!("emoji[{index}]: {error}"));
        }
        Ok(set)
    }

    pub fn contains(&self, emoji: &str) -> bool {
        self.iter().any(|entry| entry == emoji)
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.emoji.iter().map(String::as_str)
    }
}

fn is_format(ch: char) -> bool {
    // Unicode 17.0 General_Category=Format (Cf). Rust's is_control covers Cc only.
    matches!(
        ch,
        '\u{00ad}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_emoji(emoji: &str) -> String {
        json!({"version": 1, "emoji": [{"emoji": emoji, "label": "リアクション"}]}).to_string()
    }

    fn assert_rejected(json: &str, reason: &str) {
        match ReactionEmojiSet::parse(json) {
            Ok(_) => panic!("accepted {json}"),
            Err(error) => assert!(error.contains(reason), "{error}"),
        }
    }

    #[test]
    fn shipped_file_validates_and_preserves_order() {
        let set = ReactionEmojiSet::load_embedded().expect("valid embedded Reaction emoji list");
        let catalog: Catalog = serde_json::from_str(EMOJI_JSON).expect("valid JSON");
        assert!(
            set.iter()
                .eq(catalog.emoji.iter().map(|entry| entry.emoji.as_str()))
        );
    }

    #[test]
    fn accepts_joined_sequences_and_the_byte_limit() {
        for emoji in ["👩‍💻".to_owned(), "👍".repeat(8)] {
            let set = ReactionEmojiSet::parse(&with_emoji(&emoji)).expect("valid emoji");
            assert!(set.contains(&emoji));
        }
    }

    #[test]
    fn lookup_matches_the_exact_sequence() {
        let set = ReactionEmojiSet::parse(&with_emoji("❤️")).expect("valid emoji");
        assert!(set.contains("❤️"));
        assert!(!set.contains("❤"));
    }

    #[test]
    fn rejects_wrong_version() {
        assert_rejected(r#"{"version":2,"emoji":[]}"#, "expected version 1");
    }

    #[test]
    fn rejects_empty_list() {
        assert_rejected(r#"{"version":1,"emoji":[]}"#, "list must be nonempty");
    }

    #[test]
    fn rejects_empty_emoji() {
        assert_rejected(&with_emoji(""), "emoji must be nonempty");
    }

    #[test]
    fn rejects_emoji_over_byte_limit() {
        assert_rejected(&with_emoji(&"👍".repeat(9)), "exceeds 32 UTF-8 bytes");
    }

    #[test]
    fn rejects_ascii() {
        assert_rejected(&with_emoji("OK"), "plain ASCII");
    }

    #[test]
    fn rejects_whitespace_controls_and_formats() {
        for emoji in ["👍\u{a0}", "👍\u{7f}", "👍\u{200b}", "👍\u{e0020}"] {
            assert_rejected(&with_emoji(emoji), "disallowed format character");
        }
    }

    #[test]
    fn rejects_joiners_and_variation_selectors_without_a_base() {
        for emoji in ["\u{200d}👍", "👍\u{200d}", "\u{fe0f}👍"] {
            assert_rejected(&with_emoji(emoji), "no adjacent base");
        }
    }

    #[test]
    fn rejects_empty_label() {
        assert_rejected(
            r#"{"version":1,"emoji":[{"emoji":"👍","label":""}]}"#,
            "label must be nonempty",
        );
    }

    #[test]
    fn rejects_duplicate_emoji_even_with_different_labels() {
        assert_rejected(
            r#"{"version":1,"emoji":[{"emoji":"👍","label":"いいね"},{"emoji":"👍","label":"賛成"}]}"#,
            "duplicate emoji",
        );
    }

    #[test]
    fn rejects_unknown_fields_at_both_levels() {
        for json in [
            r#"{"version":1,"emoji":[],"extra":true}"#,
            r#"{"version":1,"emoji":[{"emoji":"👍","label":"いいね","extra":true}]}"#,
        ] {
            assert_rejected(json, "unknown field");
        }
    }
}
