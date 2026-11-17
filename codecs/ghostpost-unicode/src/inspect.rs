//! Strict, structured inspection of Ghostpost invisible-Unicode envelopes.
//!
//! Added during the Signal extraction. The original `decode*` functions are kept
//! byte-for-byte compatible; `inspect` is a single authoritative entry point that
//!   * locates every FEFF-delimited envelope in the input (not just the first),
//!   * validates framing (alphabet, pair alignment, base64 length),
//!   * dispatches on the payload marker instead of guessing (the legacy `decode`
//!     returns control-character garbage for a reference payload),
//!   * reports declared-but-unimplemented markers explicitly,
//!   * never panics.
//!
//! It does NOT add integrity protection: the v1 wire format has no checksum, so
//! an even number of injected alphabet characters can still yield a wrong but
//! well-formed payload. That limitation is reported in `warnings`.

use crate::hidenly::{
    decode_base64, decompress_data, MARKER_AI_PROMPT, MARKER_COMPRESSED, MARKER_CONVERSATION,
    MARKER_ADAPTIVE, MARKER_HYBRID, MARKER_METADATA, MARKER_REFERENCE, MARKER_SECURE_NOTE,
    MARKER_STORY_FRAGMENT, MARKER_UNCOMPRESSED, REF_TYPE_CROSSLINK, REF_TYPE_EXTERNAL_URL,
    REF_TYPE_GHOSTPOST, REF_TYPE_SUPABASE, AI_TYPE_ANALYST, AI_TYPE_CHATBOT, AI_TYPE_POET,
    AI_TYPE_STORYTELLER,
};

pub const DELIMITER: char = '\u{FEFF}';
/// The 8 invisible code points that form the 64 base64 symbols (as ordered pairs).
pub const ALPHABET: [char; 8] = [
    '\u{2060}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{200E}', '\u{200F}', '\u{202D}', '\u{202C}',
];
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Text { text: String, compressed: bool, legacy: bool },
    Reference { ref_type: String, ref_id: String, metadata: Option<String>, nested: bool },
    AiPrompt { ai_type: String, base_prompt: String, system_message: Option<String>, metadata: Option<String> },
    SecureNote { note_id: String, password: Option<String>, metadata: Option<String> },
    /// Marker is defined in the format but no encoder/decoder exists in Ghostpost.
    Unimplemented { marker: u8, name: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// Char (Unicode scalar) offsets of the opening and closing delimiters.
    pub start: usize,
    pub end: usize,
    pub marker: Option<u8>,
    pub result: Result<Payload, String>,
    pub warnings: Vec<String>,
}

fn symbol_index(c: char) -> Option<usize> {
    ALPHABET.iter().position(|a| *a == c)
}

/// Strictly convert invisible pairs to base64 text. Unlike the legacy
/// `encoded_to_base64`, unknown characters and odd lengths are errors, not skips.
fn strict_to_base64(chars: &[char]) -> Result<String, String> {
    if chars.is_empty() {
        return Err("Empty envelope".into());
    }
    if chars.len() % 2 != 0 {
        return Err(format!(
            "Corrupt envelope: odd symbol count ({}) — a character was inserted or removed",
            chars.len()
        ));
    }
    let mut out = String::with_capacity(chars.len() / 2);
    for (i, pair) in chars.chunks(2).enumerate() {
        let hi = symbol_index(pair[0]).ok_or_else(|| {
            format!("Corrupt envelope: U+{:04X} at symbol {} is outside the alphabet", pair[0] as u32, i * 2)
        })?;
        let lo = symbol_index(pair[1]).ok_or_else(|| {
            format!("Corrupt envelope: U+{:04X} at symbol {} is outside the alphabet", pair[1] as u32, i * 2 + 1)
        })?;
        out.push(B64[hi * 8 + lo] as char);
    }
    if out.len() % 4 == 1 {
        return Err("Corrupt envelope: impossible base64 length".into());
    }
    Ok(out)
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.at).ok_or("Truncated payload")?;
        self.at += 1;
        Ok(v)
    }
    fn len_prefixed(&mut self, field: &str) -> Result<Option<String>, String> {
        if self.at + 2 > self.b.len() {
            return Err(format!("Truncated payload: missing length of {}", field));
        }
        let n = u16::from_le_bytes([self.b[self.at], self.b[self.at + 1]]) as usize;
        self.at += 2;
        if n == 0 {
            return Ok(None);
        }
        let end = self.at + n;
        if end > self.b.len() {
            return Err(format!("Truncated payload: {} declares {} bytes, {} available", field, n, self.b.len() - self.at));
        }
        let s = String::from_utf8(self.b[self.at..end].to_vec())
            .map_err(|_| format!("Invalid UTF-8 in {}", field))?;
        self.at = end;
        Ok(Some(s))
    }
}

fn ref_type_name(t: u8) -> &'static str {
    match t {
        REF_TYPE_GHOSTPOST => "ghostpost",
        REF_TYPE_EXTERNAL_URL => "external_url",
        REF_TYPE_SUPABASE => "supabase",
        REF_TYPE_CROSSLINK => "crosslink",
        _ => "unknown",
    }
}

fn ai_type_name(t: u8) -> &'static str {
    match t {
        AI_TYPE_CHATBOT => "chatbot",
        AI_TYPE_POET => "poet",
        AI_TYPE_ANALYST => "analyst",
        AI_TYPE_STORYTELLER => "storyteller",
        _ => "unknown",
    }
}

fn parse_reference(bytes: &[u8], nested: bool) -> Result<Payload, String> {
    let mut r = Reader { b: bytes, at: 0 };
    let t = r.u8()?;
    let id = r.len_prefixed("reference id")?.ok_or("Empty reference id")?;
    let metadata = r.len_prefixed("metadata")?;
    Ok(Payload::Reference { ref_type: ref_type_name(t).into(), ref_id: id, metadata, nested })
}

fn is_plausible_ghostpost_id(id: &str) -> bool {
    // Mirrors the userscript's acceptance rule (static/ghostpost-reveal.user.js).
    let short = !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_alphanumeric());
    let uuid = id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }
        });
    short || uuid
}

fn parse_payload(bytes: &[u8], warnings: &mut Vec<String>) -> Result<Payload, String> {
    let marker = *bytes.first().ok_or("Empty decoded content")?;
    let body = &bytes[1..];
    match marker {
        MARKER_UNCOMPRESSED => {
            // Compatibility: some hosted posts were double-wrapped as
            // [0x00][0x02][0x00 ghostpost]... — the userscript accepts these.
            if body.first() == Some(&MARKER_REFERENCE) && body.get(1) == Some(&REF_TYPE_GHOSTPOST) {
                if let Ok(Payload::Reference { ref_type, ref_id, metadata, .. }) = parse_reference(&body[1..], true) {
                    if is_plausible_ghostpost_id(&ref_id) {
                        warnings.push("Nested reference inside uncompressed envelope (legacy double-wrap)".into());
                        return Ok(Payload::Reference { ref_type, ref_id, metadata, nested: true });
                    }
                }
            }
            let text = String::from_utf8(body.to_vec()).map_err(|_| "Invalid UTF-8 in text payload".to_string())?;
            Ok(Payload::Text { text, compressed: false, legacy: false })
        }
        MARKER_COMPRESSED => {
            let raw = decompress_data(body).map_err(|e| format!("Failed to decompress: {}", e))?;
            let text = String::from_utf8(raw).map_err(|_| "Invalid UTF-8 in decompressed payload".to_string())?;
            Ok(Payload::Text { text, compressed: true, legacy: false })
        }
        MARKER_REFERENCE => parse_reference(body, false),
        MARKER_AI_PROMPT => {
            let mut r = Reader { b: body, at: 0 };
            let t = r.u8()?;
            let base_prompt = r.len_prefixed("base prompt")?.unwrap_or_default();
            let system_message = r.len_prefixed("system message")?;
            let metadata = r.len_prefixed("metadata")?;
            Ok(Payload::AiPrompt { ai_type: ai_type_name(t).into(), base_prompt, system_message, metadata })
        }
        MARKER_SECURE_NOTE => {
            let mut r = Reader { b: body, at: 0 };
            let note_id = r.len_prefixed("note id")?.ok_or("Empty note id")?;
            let password = r.len_prefixed("password")?;
            let metadata = r.len_prefixed("metadata")?;
            if password.is_some() {
                warnings.push("Secure-note password is embedded in the carrier text: anyone holding the text can read it (obfuscation, not confidentiality)".into());
            }
            Ok(Payload::SecureNote { note_id, password, metadata })
        }
        MARKER_HYBRID | MARKER_METADATA | MARKER_CONVERSATION | MARKER_ADAPTIVE | MARKER_STORY_FRAGMENT => {
            let name = match marker {
                MARKER_HYBRID => "hybrid",
                MARKER_METADATA => "metadata",
                MARKER_CONVERSATION => "conversation",
                MARKER_ADAPTIVE => "adaptive",
                _ => "story_fragment",
            };
            Ok(Payload::Unimplemented { marker, name: name.into() })
        }
        _ => {
            // Pre-marker legacy messages: try raw DEFLATE, else UTF-8 text.
            warnings.push(format!("Unknown marker 0x{:02x}; interpreted as pre-marker legacy payload", marker));
            if let Ok(raw) = decompress_data(bytes) {
                if let Ok(text) = String::from_utf8(raw) {
                    return Ok(Payload::Text { text, compressed: true, legacy: true });
                }
            }
            let text = String::from_utf8(bytes.to_vec())
                .map_err(|_| format!("Unknown marker 0x{:02x} and payload is not UTF-8", marker))?;
            Ok(Payload::Text { text, compressed: false, legacy: true })
        }
    }
}

/// Find and decode every envelope in `input`. Envelopes are maximal runs of
/// alphabet characters bounded by FEFF on both sides.
pub fn inspect(input: &str) -> Vec<Envelope> {
    let chars: Vec<char> = input.chars().collect();
    let delims: Vec<usize> = chars.iter().enumerate().filter(|(_, c)| **c == DELIMITER).map(|(i, _)| i).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < delims.len() {
        let (s, e) = (delims[i], delims[i + 1]);
        let inner = &chars[s + 1..e];
        // A visible character between delimiters means these two FEFFs do not
        // bound one envelope (e.g. stray BOMs); slide forward by one delimiter.
        let has_visible = inner.iter().any(|c| symbol_index(*c).is_none());
        if inner.is_empty() || has_visible {
            i += 1;
            continue;
        }
        let mut warnings = vec!["v1 format has no integrity check: an even number of injected or dropped symbols can produce a wrong payload undetected".to_string()];
        let decoded = strict_to_base64(inner)
            .and_then(|b64| decode_base64(&b64))
            .and_then(|bytes| {
                let marker = bytes.first().copied();
                parse_payload(&bytes, &mut warnings).map(|p| (marker, p))
            });
        let (marker, result) = match decoded {
            Ok((m, p)) => (m, Ok(p)),
            Err(e) => (None, Err(e)),
        };
        out.push(Envelope { start: s, end: e, marker, result, warnings });
        i += 2;
    }
    out
}

// ---------------------------------------------------------------------------
// Minimal JSON rendering (no serde dependency) for the WASM boundary.
// ---------------------------------------------------------------------------

fn js(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 || (0x2000..=0x206F).contains(&(c as u32)) || c == '\u{FEFF}' => {
                o.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn opt(s: &Option<String>) -> String {
    s.as_ref().map(|v| js(v)).unwrap_or_else(|| "null".into())
}

pub fn payload_json(p: &Payload) -> String {
    match p {
        Payload::Text { text, compressed, legacy } => format!(
            "{{\"kind\":\"text\",\"text\":{},\"compressed\":{},\"legacy\":{}}}",
            js(text), compressed, legacy
        ),
        Payload::Reference { ref_type, ref_id, metadata, nested } => format!(
            "{{\"kind\":\"reference\",\"refType\":{},\"refId\":{},\"metadata\":{},\"nested\":{}}}",
            js(ref_type), js(ref_id), opt(metadata), nested
        ),
        Payload::AiPrompt { ai_type, base_prompt, system_message, metadata } => format!(
            "{{\"kind\":\"ai_prompt\",\"aiType\":{},\"basePrompt\":{},\"systemMessage\":{},\"metadata\":{}}}",
            js(ai_type), js(base_prompt), opt(system_message), opt(metadata)
        ),
        Payload::SecureNote { note_id, password, metadata } => format!(
            "{{\"kind\":\"secure_note\",\"noteId\":{},\"password\":{},\"metadata\":{}}}",
            js(note_id), opt(password), opt(metadata)
        ),
        Payload::Unimplemented { marker, name } => format!(
            "{{\"kind\":\"unimplemented\",\"marker\":{},\"name\":{}}}",
            marker, js(name)
        ),
    }
}

pub fn inspect_json(input: &str) -> String {
    let items: Vec<String> = inspect(input)
        .iter()
        .map(|e| {
            let (ok, body) = match &e.result {
                Ok(p) => ("true", format!("\"payload\":{}", payload_json(p))),
                Err(err) => ("false", format!("\"error\":{}", js(err))),
            };
            let w: Vec<String> = e.warnings.iter().map(|x| js(x)).collect();
            format!(
                "{{\"start\":{},\"end\":{},\"marker\":{},\"ok\":{},{},\"warnings\":[{}]}}",
                e.start,
                e.end,
                e.marker.map(|m| m.to_string()).unwrap_or_else(|| "null".into()),
                ok,
                body,
                w.join(",")
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hidenly::{encode, encode_ai_prompt, encode_reference, encode_secure_note};

    fn only(input: &str) -> Envelope {
        let v = inspect(input);
        assert_eq!(v.len(), 1, "expected exactly one envelope, got {:?}", v);
        v.into_iter().next().unwrap()
    }

    #[test]
    fn text_roundtrip_small_and_compressed() {
        let big = "z".repeat(5000);
        for secret in ["bye", "Unicode ✓ 🙂 émoji", big.as_str()] {
            let e = only(&encode("visible", secret));
            match e.result.unwrap() {
                Payload::Text { text, compressed, .. } => {
                    assert_eq!(text, secret);
                    assert_eq!(compressed, secret.len() >= 1000);
                }
                p => panic!("unexpected {:?}", p),
            }
        }
    }

    #[test]
    fn reference_is_dispatched_not_misdecoded() {
        let enc = encode_reference("see this", 0, "abc123", Some("{\"k\":1}"));
        // Legacy decode() misinterprets a reference as text: demonstrate the defect.
        let legacy = crate::hidenly::decode(&enc).unwrap();
        assert!(legacy.starts_with('\u{2}'), "legacy decode returns control bytes");
        assert_eq!(
            only(&enc).result.unwrap(),
            Payload::Reference { ref_type: "ghostpost".into(), ref_id: "abc123".into(), metadata: Some("{\"k\":1}".into()), nested: false }
        );
    }

    #[test]
    fn ai_prompt_and_secure_note() {
        let a = only(&encode_ai_prompt("v", 1, "write a poem", None, Some("m")));
        assert_eq!(a.result.unwrap(), Payload::AiPrompt { ai_type: "poet".into(), base_prompt: "write a poem".into(), system_message: None, metadata: Some("m".into()) });
        let s = only(&encode_secure_note("v", "note-1", Some("hunter2"), None));
        assert!(s.warnings.iter().any(|w| w.contains("password is embedded")));
        assert_eq!(s.result.unwrap(), Payload::SecureNote { note_id: "note-1".into(), password: Some("hunter2".into()), metadata: None });
    }

    #[test]
    fn single_injected_symbol_is_detected() {
        let enc = encode("ab", "hi there");
        let mut chars: Vec<char> = enc.chars().collect();
        let first = chars.iter().position(|c| *c == DELIMITER).unwrap();
        chars.insert(first + 3, '\u{200B}');
        let corrupted: String = chars.into_iter().collect();
        // Legacy decoder silently returns something; strict inspect reports corruption.
        let e = only(&corrupted);
        assert!(e.result.unwrap_err().contains("odd symbol count"));
    }

    #[test]
    fn truncated_payloads_error_instead_of_panicking() {
        // [0x09][len=1]['x'][pwd len=0] and missing metadata length
        let enc_b64 = crate::hidenly::encode_base64(&[0x09, 1, 0, b'x', 0, 0, 0]);
        let wrapped = format!("a{}{}{}b", DELIMITER, crate::hidenly::base64_to_encoded(&enc_b64), DELIMITER);
        assert!(only(&wrapped).result.is_err());
        assert!(crate::hidenly::decode_secure_note(&wrapped).is_err(), "legacy path must not panic");
        let enc_b64 = crate::hidenly::encode_base64(&[0x05, 0, 1]);
        let wrapped = format!("a{}{}{}b", DELIMITER, crate::hidenly::base64_to_encoded(&enc_b64), DELIMITER);
        assert!(crate::hidenly::decode_ai_prompt(&wrapped).is_err(), "legacy path must not panic");
    }

    #[test]
    fn multiple_envelopes_and_unimplemented_markers() {
        let a = encode("first", "one");
        let b = encode_reference("second", 1, "https://example.com/x", None);
        let hyb = format!("x{}{}{}y", DELIMITER, crate::hidenly::base64_to_encoded(&crate::hidenly::encode_base64(&[0x03, 1, 2])), DELIMITER);
        let all = format!("{} | {} | {}", a, b, hyb);
        let v = inspect(&all);
        assert_eq!(v.len(), 3);
        assert!(matches!(v[0].result, Ok(Payload::Text { .. })));
        assert!(matches!(&v[1].result, Ok(Payload::Reference { ref_type, .. }) if ref_type == "external_url"));
        assert!(matches!(&v[2].result, Ok(Payload::Unimplemented { name, .. }) if name == "hybrid"));
    }

    #[test]
    fn plain_text_and_stray_boms_yield_nothing() {
        assert!(inspect("hello world").is_empty());
        assert!(inspect("\u{FEFF}BOM-prefixed file text\u{FEFF} more").is_empty());
        // Emoji ZWJ sequences outside an envelope are not envelopes.
        assert!(inspect("👨‍👩‍👧 family").is_empty());
    }

    #[test]
    fn legacy_double_wrapped_reference() {
        let mut bytes = vec![0x00, 0x02, 0x00];
        bytes.extend_from_slice(&(6u16).to_le_bytes());
        bytes.extend_from_slice(b"abc123");
        bytes.extend_from_slice(&[0, 0]);
        let wrapped = format!("a{}{}{}b", DELIMITER, crate::hidenly::base64_to_encoded(&crate::hidenly::encode_base64(&bytes)), DELIMITER);
        assert!(matches!(only(&wrapped).result, Ok(Payload::Reference { nested: true, .. })));
    }

    #[test]
    fn json_escapes_invisible_and_control_chars() {
        let j = inspect_json(&encode("v", "a\"b\u{200B}\n"));
        assert!(j.contains("a\\\"b\\u200b\\n"));
    }
}
