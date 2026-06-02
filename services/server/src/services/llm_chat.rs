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
    /// `Option<String>` because `gpt-4o-mini` (and likely other
    /// OpenAI-compatible providers via OpenRouter) occasionally returns
    /// a successful HTTP 200 response with `content: null` and
    /// `completion_tokens: 0` — the model accepted the prompt but
    /// produced no output. Previously this was typed as `String` and
    /// the deserialiser rejected it with "invalid type: null, expected
    /// a string", returning HTTP 500 which the SDK / harness retry
    /// policy does not retry — silently dropping the turn.
    ///
    /// Callers treat `None` as "" (empty string). For the extractor
    /// that flows through `parse_extracted_facts` and produces zero
    /// facts — the same legitimate outcome as the prompt's explicit
    /// `NONE` response, so this is correct degradation rather than
    /// an error.
    pub content: Option<String>,
}
