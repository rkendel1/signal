//! Ghostpost invisible-Unicode codec (Signal codec provider `ghostpost-unicode/v1`).
//!
//! Extracted from rkendel1/ghostpost `wasm/` at commit 369220a. The encoders and
//! legacy decoders keep the original wire format and WASM export names so that
//! existing Ghostpost content, the browser extension and the userscript stay
//! compatible. Additions: bounds-checked parsing and `inspect` (strict,
//! multi-envelope, marker-dispatched decoding).

pub mod hidenly;
pub mod inspect;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use crate::{hidenly, inspect};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn decode(input: &str) -> Result<String, JsValue> {
        hidenly::decode(input).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn encode(input: &str, secret: &str) -> String {
        hidenly::encode(input, secret)
    }
    #[wasm_bindgen]
    pub fn encode_reference(input: &str, reference_type: u8, reference_id: &str, metadata: &str) -> String {
        let m = if metadata.is_empty() { None } else { Some(metadata) };
        hidenly::encode_reference(input, reference_type, reference_id, m)
    }
    #[wasm_bindgen]
    pub fn encode_ai_prompt(input: &str, ai_type: u8, base_prompt: &str, system_message: &str, metadata: &str) -> String {
        let s = if system_message.is_empty() { None } else { Some(system_message) };
        let m = if metadata.is_empty() { None } else { Some(metadata) };
        hidenly::encode_ai_prompt(input, ai_type, base_prompt, s, m)
    }
    #[wasm_bindgen]
    pub fn encode_secure_note(input: &str, note_id: &str, password: &str, metadata: &str) -> String {
        let p = if password.is_empty() { None } else { Some(password) };
        let m = if metadata.is_empty() { None } else { Some(metadata) };
        hidenly::encode_secure_note(input, note_id, p, m)
    }
    /// Strict structured decode of every envelope in `input`, as JSON.
    #[wasm_bindgen]
    pub fn inspect(input: &str) -> String {
        inspect::inspect_json(input)
    }
}
