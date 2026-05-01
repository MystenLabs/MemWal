//! Service-layer capabilities — callable building blocks that handlers compose.
//!
//! Each service is a trait + a default production implementation. Handlers
//! receive trait objects (`Arc<dyn Embedder>`, etc.) via `AppState`, so
//! alternative implementations (mock, local-model, hybrid) can be swapped in
//! at startup without touching handler code.
//!
//! Why "services" and not "pipeline": MemWal isn't a single linear flow.
//! Different handlers compose these capabilities in different orders, with
//! different fan-out and parallelism. Each module here is a *callable
//! capability*, not a "stage" that data flows through. See
//! `whole-system-documents/memory-protocol-improvement/refactor-plan/PLAN.md`
//! for the full reasoning.

pub mod embedder;
pub mod extractor;
pub mod llm_chat;

// Placeholder modules — reserved namespace for follow-up work. See each
// module's doc comment for the planned scope. They contain no code today
// because dev's base has no consolidator or composite scoring; inventing a
// trait without a real caller would be premature design.
pub mod consolidator;
pub mod ranker;

pub use embedder::{Embedder, OpenAiEmbedder};
pub use extractor::{Extractor, LlmExtractor};
