use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MEMORY_ARTIFACT_SCHEMA: &str = "memwal.memory_artifact";
pub const MEMORY_ARTIFACT_VERSION: u32 = 1;
pub const MEMORY_PIPELINE_VERSION: &str = "memory-pipeline-rag-v1";
pub const DEFAULT_EMBEDDING_MODEL: &str = "openai/text-embedding-3-small";

const MAX_CHUNK_BYTES: usize = 3_000;
const CHUNK_OVERLAP_BYTES: usize = 300;
const MIN_NATURAL_BREAK_BYTES: usize = 1_200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryArtifactV1 {
    pub schema: String,
    pub version: u32,
    pub artifact_id: String,
    pub owner: String,
    pub namespace: String,
    pub kind: String,
    pub source: MemorySource,
    pub authors: Vec<MemoryAuthor>,
    pub raw: RawMemoryContent,
    pub cleaned: Option<CleanedMemoryContent>,
    pub chunks: Vec<MemoryChunk>,
    pub catalog: Option<MemoryCatalog>,
    pub metadata: MemoryArtifactMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub uri: Option<String>,
    pub title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryAuthor {
    pub id: String,
    pub role: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMemoryContent {
    pub content_type: String,
    pub text: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanedMemoryContent {
    pub text: String,
    pub transform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryChunk {
    pub id: String,
    pub text: String,
    pub source_span: SourceSpan,
    pub section: Option<String>,
    pub authors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCatalog {
    pub summary: String,
    pub topics: Vec<String>,
    pub entities: Vec<String>,
    pub claims: Vec<String>,
    pub derivation: CatalogDerivation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogDerivation {
    pub model: String,
    pub prompt_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryArtifactMetadata {
    pub created_by: String,
    pub pipeline_version: String,
}

#[derive(Debug, Clone)]
pub enum ParsedMemoryPayload {
    Artifact(MemoryArtifactV1),
    LegacyPlaintext(String),
}

#[derive(Debug, Clone)]
pub struct IndexText {
    pub id_suffix: String,
    pub artifact_id: Option<String>,
    pub index_kind: String,
    pub source_ref: Option<String>,
    pub indexed_text_kind: String,
    pub text: String,
}

pub fn build_artifact(
    owner: &str,
    namespace: &str,
    text: String,
    author_id: &str,
) -> MemoryArtifactV1 {
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let chunks = chunk_text(&text, author_id);

    MemoryArtifactV1 {
        schema: MEMORY_ARTIFACT_SCHEMA.to_string(),
        version: MEMORY_ARTIFACT_VERSION,
        artifact_id,
        owner: owner.to_string(),
        namespace: namespace.to_string(),
        kind: "note".to_string(),
        source: MemorySource {
            source_type: "note".to_string(),
            uri: None,
            title: None,
            created_at: now,
        },
        authors: vec![MemoryAuthor {
            id: author_id.to_string(),
            role: "user".to_string(),
            display_name: None,
        }],
        raw: RawMemoryContent {
            content_type: "text/plain".to_string(),
            sha256: sha256_hex(text.as_bytes()),
            text,
        },
        cleaned: None,
        chunks,
        catalog: None,
        metadata: MemoryArtifactMetadata {
            created_by: "relayer".to_string(),
            pipeline_version: MEMORY_PIPELINE_VERSION.to_string(),
        },
    }
}

pub fn serialize_artifact(artifact: &MemoryArtifactV1) -> Result<String, serde_json::Error> {
    serde_json::to_string(artifact)
}

pub fn parse_payload(text: String) -> ParsedMemoryPayload {
    match serde_json::from_str::<MemoryArtifactV1>(&text) {
        Ok(artifact)
            if artifact.schema == MEMORY_ARTIFACT_SCHEMA
                && artifact.version == MEMORY_ARTIFACT_VERSION =>
        {
            ParsedMemoryPayload::Artifact(artifact)
        }
        _ => ParsedMemoryPayload::LegacyPlaintext(text),
    }
}

pub fn index_texts_for_payload(payload: &ParsedMemoryPayload) -> Vec<IndexText> {
    match payload {
        ParsedMemoryPayload::Artifact(artifact) => index_texts_for_artifact(artifact),
        ParsedMemoryPayload::LegacyPlaintext(text) => vec![IndexText {
            id_suffix: "whole".to_string(),
            artifact_id: None,
            index_kind: "whole".to_string(),
            source_ref: None,
            indexed_text_kind: "raw".to_string(),
            text: text.clone(),
        }],
    }
}

pub fn index_texts_for_artifact(artifact: &MemoryArtifactV1) -> Vec<IndexText> {
    let mut entries = Vec::with_capacity(artifact.chunks.len() + 1);
    entries.push(IndexText {
        id_suffix: "whole".to_string(),
        artifact_id: Some(artifact.artifact_id.clone()),
        index_kind: "whole".to_string(),
        source_ref: None,
        indexed_text_kind: "raw".to_string(),
        text: artifact.raw.text.clone(),
    });

    for chunk in &artifact.chunks {
        entries.push(IndexText {
            id_suffix: chunk.id.clone(),
            artifact_id: Some(artifact.artifact_id.clone()),
            index_kind: "chunk".to_string(),
            source_ref: Some(chunk.id.clone()),
            indexed_text_kind: "raw".to_string(),
            text: chunk.text.clone(),
        });
    }

    entries
}

pub fn recall_text_for_hit(payload: &ParsedMemoryPayload, source_ref: Option<&str>) -> String {
    match payload {
        ParsedMemoryPayload::Artifact(artifact) => {
            if let Some(source_ref) = source_ref {
                if let Some(chunk) = artifact.chunks.iter().find(|chunk| chunk.id == source_ref) {
                    return chunk.text.clone();
                }
            }
            artifact.raw.text.clone()
        }
        ParsedMemoryPayload::LegacyPlaintext(text) => text.clone(),
    }
}

fn chunk_text(text: &str, author_id: &str) -> Vec<MemoryChunk> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    let len = text.len();

    while start < len {
        start = next_char_boundary(text, start);
        let mut end = (start + MAX_CHUNK_BYTES).min(len);
        end = prev_char_boundary(text, end);

        if end < len {
            let min_break = (start + MIN_NATURAL_BREAK_BYTES).min(end);
            if let Some(natural_end) = find_natural_break(text, start, min_break, end) {
                end = natural_end;
            }
        }

        if end <= start {
            end = next_char_boundary(text, (start + MAX_CHUNK_BYTES).min(len));
        }
        if end <= start {
            break;
        }

        let chunk_text = text[start..end].trim().to_string();
        if !chunk_text.is_empty() {
            let id = format!("chunk-{}", chunks.len());
            chunks.push(MemoryChunk {
                id,
                text: chunk_text,
                source_span: SourceSpan { start, end },
                section: None,
                authors: vec![author_id.to_string()],
            });
        }

        if end >= len {
            break;
        }

        let overlap_start = end.saturating_sub(CHUNK_OVERLAP_BYTES);
        let next_start = if overlap_start > start {
            prev_char_boundary(text, overlap_start)
        } else {
            end
        };
        start = if next_start > start { next_start } else { end };
    }

    chunks
}

fn find_natural_break(text: &str, start: usize, min_break: usize, end: usize) -> Option<usize> {
    let window = &text[start..end];
    let min_rel = min_break.saturating_sub(start);
    for pattern in ["\n\n", "\n", ". ", "? ", "! "] {
        if let Some(pos) = window[min_rel..].rfind(pattern) {
            let candidate = start + min_rel + pos + pattern.len();
            if candidate > start && candidate <= end && text.is_char_boundary(candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn prev_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_round_trips_and_indexes_chunks() {
        let text = "alpha ".repeat(2_000);
        let artifact = build_artifact("0xowner", "default", text, "agent");
        assert!(artifact.chunks.len() > 1);

        let serialized = serialize_artifact(&artifact).unwrap();
        let parsed = parse_payload(serialized);
        let entries = index_texts_for_payload(&parsed);
        assert!(entries.iter().any(|entry| entry.index_kind == "whole"));
        assert!(entries.iter().any(|entry| entry.index_kind == "chunk"));
    }

    #[test]
    fn legacy_plaintext_falls_back() {
        let parsed = parse_payload("remember this exactly".to_string());
        match parsed {
            ParsedMemoryPayload::LegacyPlaintext(text) => assert_eq!(text, "remember this exactly"),
            ParsedMemoryPayload::Artifact(_) => panic!("expected legacy plaintext"),
        }
    }
}
