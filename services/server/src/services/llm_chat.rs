//! Shared OpenAI-compatible chat-completion request/response types.
//!
//! Used by `services/extractor.rs` (LLM-driven fact extraction) and — for
//! now — by the `summarize_*` helpers + the `ask` handler in `routes.rs`
//! (both of which keep their inline call logic but share these wire types).
//! When the `ask` / summarisation prompts become versioned assets in
//! Phase 3, those call sites will load their prompts the same way the
//! extractor does and keep using these types unchanged.
//!
//! `max_tokens` is on the request because all three current callers set
//! it (extractor: a small cap for the one-line-per-fact response;
//! summariser: per-chunk budget; ask: the answer budget).

#[derive(serde::Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(serde::Deserialize)]
pub struct ChatCompletionResponse {
    pub choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
pub struct ChatChoice {
    pub message: ChatMessageResp,
}

#[derive(serde::Deserialize)]
pub struct ChatMessageResp {
    pub content: String,
}
