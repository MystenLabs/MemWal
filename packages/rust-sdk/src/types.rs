use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RememberAcceptedResult {
    pub job_id: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RememberResult {
    pub id: String,
    pub job_id: Option<String>,
    pub blob_id: String,
    pub owner: String,
    pub namespace: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RememberJobStatus {
    pub job_id: String,
    pub status: String, // "pending" | "running" | "uploaded" | "done" | "failed" | "not_found"
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub blob_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecallMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecallResult {
    pub results: Vec<RecallMemory>,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RecallParams {
    pub query: String,
    pub limit: Option<usize>,
    pub top_k: Option<usize>, // Alias for limit
    pub namespace: Option<String>,
    pub max_distance: Option<f64>, // Distance threshold for local filtering
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmbedResult {
    pub vector: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnalyzedFact {
    pub text: String,
    pub id: String,
    pub job_id: Option<String>,
    pub blob_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnalyzeResult {
    pub job_ids: Vec<String>,
    pub facts: Vec<AnalyzedFact>,
    pub fact_count: usize,
    pub status: String,
    pub owner: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AskMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AskResponse {
    pub answer: String,
    pub memories_used: usize,
    pub memories: Vec<AskMemory>,
}
