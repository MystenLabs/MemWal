//! Shared OpenAI-compatible chat-completion request/response types.
//!
//! Used by `services/extractor.rs` (LLM-driven fact extraction) and by the
//! `ask` handler (memory-augmented Q&A). When the `ask` prompt becomes a
//! versioned asset in Phase 3, both call sites will load their prompts the
//! same way and share these types unchanged.

#[derive(serde::Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
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
