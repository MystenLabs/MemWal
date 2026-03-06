use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::types::{AppError, SearchHit};

pub struct VectorDb {
    conn: Mutex<Connection>,
}

impl VectorDb {
    /// Initialize database, create tables, load sqlite-vec extension
    pub fn new(db_path: &str, dimensions: usize) -> Result<Self, AppError> {
        // Ensure parent directory exists
        if let Some(parent) = Path::new(db_path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Internal(format!("Failed to create DB directory: {}", e))
            })?;
        }

        let conn = Connection::open(db_path).map_err(|e| {
            AppError::Internal(format!("Failed to open database: {}", e))
        })?;

        // Load sqlite-vec extension
        // sqlite-vec is loaded via rusqlite's bundled feature or as loadable extension
        // For now we use a pure-SQL approach for vector storage
        // and compute cosine similarity in Rust

        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| AppError::Internal(format!("Failed to set WAL mode: {}", e)))?;

        // Create metadata table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vector_entries (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                blob_id TEXT NOT NULL,
                vector BLOB NOT NULL,
                enc_key BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_vector_entries_owner
                ON vector_entries(owner);
            CREATE INDEX IF NOT EXISTS idx_vector_entries_blob_id
                ON vector_entries(blob_id);",
        )
        .map_err(|e| AppError::Internal(format!("Failed to create tables: {}", e)))?;

        tracing::info!(
            "Database initialized at {} (dimensions: {})",
            db_path,
            dimensions
        );

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert a vector entry with encryption key
    pub fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        blob_id: &str,
        vector: &[f32],
        enc_key: &[u8],
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::Internal(format!("DB lock poisoned: {}", e))
        })?;

        // Store vector as raw bytes (f32 → little-endian bytes)
        let vector_bytes = vector_to_bytes(vector);
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT INTO vector_entries (id, owner, blob_id, vector, enc_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, owner, blob_id, vector_bytes, enc_key, now],
        )
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        tracing::debug!("Inserted vector: id={}, blob_id={}, owner={}", id, blob_id, owner);
        Ok(())
    }

    /// Search for similar vectors using cosine similarity
    /// Returns blob_id, distance, and enc_key for each match
    pub fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        let conn = self.conn.lock().map_err(|e| {
            AppError::Internal(format!("DB lock poisoned: {}", e))
        })?;

        // Fetch all vectors for this owner
        // (In production with large datasets, use sqlite-vec or HNSW index)
        let mut stmt = conn
            .prepare(
                "SELECT blob_id, vector, enc_key FROM vector_entries WHERE owner = ?1",
            )
            .map_err(|e| AppError::Internal(format!("Failed to prepare query: {}", e)))?;

        let rows = stmt
            .query_map(params![owner], |row| {
                let blob_id: String = row.get(0)?;
                let vector_bytes: Vec<u8> = row.get(1)?;
                let enc_key: Vec<u8> = row.get(2)?;
                Ok((blob_id, vector_bytes, enc_key))
            })
            .map_err(|e| AppError::Internal(format!("Failed to query vectors: {}", e)))?;

        let mut results: Vec<SearchHit> = Vec::new();

        for row in rows {
            let (blob_id, vector_bytes, enc_key) = row.map_err(|e| {
                AppError::Internal(format!("Failed to read row: {}", e))
            })?;

            let stored_vector = bytes_to_vector(&vector_bytes);
            let distance = cosine_distance(query_vector, &stored_vector);

            results.push(SearchHit {
                blob_id,
                distance,
                enc_key: hex::encode(&enc_key),
            });
        }

        // Sort by distance (ascending = most similar first)
        results.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
        results.truncate(limit);

        Ok(results)
    }
}

// ============================================================
// Vector Math Helpers
// ============================================================

/// Convert f32 vector to bytes (little-endian)
fn vector_to_bytes(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Convert bytes back to f32 vector
fn bytes_to_vector(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Cosine distance = 1 - cosine_similarity
/// Lower distance = more similar
fn cosine_distance(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for (x, y) in a.iter().zip(b.iter()) {
        let x = *x as f64;
        let y = *y as f64;
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 1.0; // max distance if zero vector
    }

    1.0 - (dot / denom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_distance_identical() {
        let v = vec![1.0, 2.0, 3.0];
        let dist = cosine_distance(&v, &v);
        assert!(dist.abs() < 1e-10);
    }

    #[test]
    fn test_cosine_distance_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let dist = cosine_distance(&a, &b);
        assert!((dist - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_vector_roundtrip() {
        let original = vec![0.1, -0.5, 3.14, 0.0];
        let bytes = vector_to_bytes(&original);
        let restored = bytes_to_vector(&bytes);
        assert_eq!(original, restored);
    }
}
