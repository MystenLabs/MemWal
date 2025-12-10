/// Memory management module for Personal Data Wallet
///
/// This module provides memory record management with:
/// - Rich metadata for encrypted content stored on Walrus
/// - Support for both capability-based and legacy address-based access
/// - Vector embedding storage for semantic search
/// - Knowledge graph integration
///
/// V2 Changes (Capability-based):
/// - Added capability_id field to link memories to MemoryCap
/// - New create_memory_with_cap() for capability-based creation
/// - Maintains backward compatibility with existing functions
module pdw::memory {
    use std::string::{Self, String};
    use sui::vec_map::{Self, VecMap};

    // Events
    public struct MemoryCreated has copy, drop {
        id: object::ID,
        owner: address,
        category: String,
        vector_id: u64,
        /// V2: Link to MemoryCap object ID
        capability_id: Option<address>,
        /// V2: App context for filtering (e.g., "MEMO", "HEALTH")
        /// - Query all: no filter
        /// - Query by context: filter by app_id
        app_id: Option<String>,
    }

    public struct MemoryIndexUpdated has copy, drop {
        id: object::ID,
        owner: address,
        version: u64,
        index_blob_id: String,
        graph_blob_id: String
    }

    public struct MemoryMetadataUpdated has copy, drop {
        memory_id: object::ID,
        metadata_blob_id: String,
        embedding_dimension: u64
    }

    /// Event emitted when a memory record is updated
    public struct MemoryUpdated has copy, drop {
        id: object::ID,
        owner: address,
        /// Fields that were updated (bitmask: 1=blob_id, 2=category, 4=topic, 8=importance, 16=embedding)
        updated_fields: u8,
        new_blob_id: Option<String>,
        new_category: Option<String>,
        updated_at: u64,
    }

    // Custom metadata struct for memory objects (inspired by Walrus metadata.move)
    public struct MemoryMetadata has drop, store {
        // Content identification
        content_type: String,
        content_size: u64,
        content_hash: String, // Should be set to Walrus blob_id (already content-addressed via blake2b256)
        
        // Memory classification
        category: String,
        topic: String,
        importance: u8, // 1-10 scale
        
        // Vector embedding (768 dimensions)
        embedding_blob_id: String, // Points to serialized embedding on Walrus
        embedding_dimension: u64,  // Should be 768 for Gemini embeddings
        
        // Temporal metadata
        created_timestamp: u64,
        updated_timestamp: u64,
        
        // Additional metadata using VecMap (extensible)
        custom_metadata: VecMap<String, String>
    }

    // Points to the HNSW index and Knowledge Graph files on Walrus
    public struct MemoryIndex has key {
        id: object::UID,
        owner: address,
        version: u64,
        index_blob_id: String, // Pointer to index.hnsw
        graph_blob_id: String  // Pointer to graph.json
    }

    // A simple on-chain record of an encrypted memory with rich metadata
    public struct Memory has key {
        id: object::UID,
        owner: address,
        category: String,
        vector_id: u64, // Links to the HNSW index ID
        blob_id: String, // Pointer to the encrypted content on Walrus
        metadata: MemoryMetadata, // Rich metadata with embeddings
        /// V2: Link to MemoryCap for capability-based access control
        /// If set, access is controlled via MemoryCap ownership
        /// If none, falls back to owner-based access (legacy)
        capability_id: Option<address>,
        /// V2: App context for context-based querying
        /// Copied from MemoryCap.app_id for efficient filtering
        /// - Query all memories: getOwnedObjects without filter
        /// - Query by context: filter by app_id field
        app_id: Option<String>,
    }

    // Error codes
    const ENonOwner: u64 = 0;
    const EInvalidVersion: u64 = 1;
    const EInvalidEmbeddingDimension: u64 = 2;
    const EInvalidImportance: u64 = 3;

    /// Create a new memory index for a user
    public entry fun create_memory_index(
        index_blob_id: vector<u8>,
        graph_blob_id: vector<u8>,
        ctx: &mut tx_context::TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let id = object::new(ctx);
        let object_id = object::uid_to_inner(&id);
        
        let memory_index = MemoryIndex {
            id,
            owner,
            version: 1,
            index_blob_id: string::utf8(index_blob_id),
            graph_blob_id: string::utf8(graph_blob_id)
        };

        // Emit event
        sui::event::emit(MemoryIndexUpdated {
            id: object_id,
            owner,
            version: 1,
            index_blob_id: string::utf8(index_blob_id),
            graph_blob_id: string::utf8(graph_blob_id)
        });

        transfer::transfer(memory_index, owner);
    }

    /// Update an existing memory index with new blob IDs
    public entry fun update_memory_index(
        memory_index: &mut MemoryIndex,
        expected_version: u64,
        new_index_blob_id: vector<u8>,
        new_graph_blob_id: vector<u8>,
        ctx: &tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == memory_index.owner, ENonOwner);
        assert!(expected_version == memory_index.version, EInvalidVersion);
        
        // Update the blob IDs
        memory_index.index_blob_id = string::utf8(new_index_blob_id);
        memory_index.graph_blob_id = string::utf8(new_graph_blob_id);
        
        // Increment the version
        memory_index.version = memory_index.version + 1;

        // Emit event
        sui::event::emit(MemoryIndexUpdated {
            id: object::uid_to_inner(&memory_index.id),
            owner: memory_index.owner,
            version: memory_index.version,
            index_blob_id: memory_index.index_blob_id,
            graph_blob_id: memory_index.graph_blob_id
        });
    }

    /// Create metadata struct with embedding
    public fun create_memory_metadata(
        content_type: vector<u8>,
        content_size: u64,
        content_hash: vector<u8>,
        category: vector<u8>,
        topic: vector<u8>,
        importance: u8,
        embedding_blob_id: vector<u8>,
        embedding_dimension: u64,
        created_timestamp: u64
    ): MemoryMetadata {
        // Validate importance scale (1-10)
        assert!(importance >= 1 && importance <= 10, EInvalidImportance);
        
        // Validate embedding dimension (should be 768 for Gemini)
        assert!(embedding_dimension == 768, EInvalidEmbeddingDimension);
        
        MemoryMetadata {
            content_type: string::utf8(content_type),
            content_size,
            content_hash: string::utf8(content_hash),
            category: string::utf8(category),
            topic: string::utf8(topic),
            importance,
            embedding_blob_id: string::utf8(embedding_blob_id),
            embedding_dimension,
            created_timestamp,
            updated_timestamp: created_timestamp,
            custom_metadata: vec_map::empty()
        }
    }

    /// Create a new memory record with rich metadata (LEGACY - for backward compatibility)
    ///
    /// NOTE: For new implementations, use create_memory_with_cap() instead
    /// which provides capability-based access control.
    public entry fun create_memory_record(
        category: vector<u8>,
        vector_id: u64,
        blob_id: vector<u8>,
        // Metadata parameters
        content_type: vector<u8>,
        content_size: u64,
        content_hash: vector<u8>,
        topic: vector<u8>,
        importance: u8,
        embedding_blob_id: vector<u8>,
        ctx: &mut tx_context::TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let id = object::new(ctx);
        let object_id = object::uid_to_inner(&id);
        let timestamp = tx_context::epoch_timestamp_ms(ctx);

        // Create metadata
        let metadata = create_memory_metadata(
            content_type,
            content_size,
            content_hash,
            category,
            topic,
            importance,
            embedding_blob_id,
            768, // Gemini embedding dimension
            timestamp
        );

        let memory = Memory {
            id,
            owner,
            category: string::utf8(category),
            vector_id,
            blob_id: string::utf8(blob_id),
            metadata,
            capability_id: option::none(),
            app_id: option::none(),  // Legacy: no app context
        };

        // Emit event
        sui::event::emit(MemoryCreated {
            id: object_id,
            owner,
            category: string::utf8(category),
            vector_id,
            capability_id: option::none(),
            app_id: option::none(),
        });

        // Emit metadata event
        sui::event::emit(MemoryMetadataUpdated {
            memory_id: object_id,
            metadata_blob_id: string::utf8(embedding_blob_id),
            embedding_dimension: 768
        });

        transfer::transfer(memory, owner);
    }

    /// Create a new memory record with capability-based access control (V2 - RECOMMENDED)
    ///
    /// This function links the memory to a MemoryCap for SEAL-compliant access control.
    /// Benefits:
    /// - Access controlled via MemoryCap ownership
    /// - Cross-dApp sharing "just works" (same owner = access)
    /// - No allowlist management needed
    ///
    /// @param cap: Reference to the MemoryCap (proves ownership)
    /// @param category: Memory category
    /// @param vector_id: Links to HNSW index
    /// @param blob_id: Pointer to encrypted content on Walrus
    /// @param content_type: MIME type
    /// @param content_size: Size in bytes
    /// @param content_hash: Content hash (blob_id)
    /// @param topic: Topic classification
    /// @param importance: Importance scale (1-10)
    /// @param embedding_blob_id: Pointer to embedding on Walrus
    /// @param ctx: Transaction context
    public entry fun create_memory_with_cap(
        cap: &pdw::capability::MemoryCap,
        category: vector<u8>,
        vector_id: u64,
        blob_id: vector<u8>,
        // Metadata parameters
        content_type: vector<u8>,
        content_size: u64,
        content_hash: vector<u8>,
        topic: vector<u8>,
        importance: u8,
        embedding_blob_id: vector<u8>,
        ctx: &mut tx_context::TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let id = object::new(ctx);
        let object_id = object::uid_to_inner(&id);
        let timestamp = tx_context::epoch_timestamp_ms(ctx);

        // Get capability info for linking
        let cap_id = pdw::capability::get_cap_id(cap);
        let cap_app_id = pdw::capability::get_app_id(cap);

        // Create metadata
        let metadata = create_memory_metadata(
            content_type,
            content_size,
            content_hash,
            category,
            topic,
            importance,
            embedding_blob_id,
            768, // Gemini embedding dimension
            timestamp
        );

        let memory = Memory {
            id,
            owner,
            category: string::utf8(category),
            vector_id,
            blob_id: string::utf8(blob_id),
            metadata,
            capability_id: option::some(cap_id),
            app_id: option::some(cap_app_id),  // Copy app_id for context-based querying
        };

        // Emit event with capability link
        sui::event::emit(MemoryCreated {
            id: object_id,
            owner,
            category: string::utf8(category),
            vector_id,
            capability_id: option::some(cap_id),
            app_id: option::some(cap_app_id),
        });

        // Emit metadata event
        sui::event::emit(MemoryMetadataUpdated {
            memory_id: object_id,
            metadata_blob_id: string::utf8(embedding_blob_id),
            embedding_dimension: 768
        });

        transfer::transfer(memory, owner);
    }

    /// Update metadata for an existing memory
    public entry fun update_memory_metadata(
        memory: &mut Memory,
        new_topic: vector<u8>,
        new_importance: u8,
        ctx: &tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == memory.owner, ENonOwner);
        assert!(new_importance >= 1 && new_importance <= 10, EInvalidImportance);
        
        // Update metadata
        memory.metadata.topic = string::utf8(new_topic);
        memory.metadata.importance = new_importance;
        memory.metadata.updated_timestamp = tx_context::epoch_timestamp_ms(ctx);
        
        // Emit metadata update event
        sui::event::emit(MemoryMetadataUpdated {
            memory_id: object::uid_to_inner(&memory.id),
            metadata_blob_id: memory.metadata.embedding_blob_id,
            embedding_dimension: memory.metadata.embedding_dimension
        });
    }

    /// Add custom metadata field
    public entry fun add_custom_metadata(
        memory: &mut Memory,
        key: vector<u8>,
        value: vector<u8>,
        ctx: &tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == memory.owner, ENonOwner);

        vec_map::insert(&mut memory.metadata.custom_metadata,
                       string::utf8(key),
                       string::utf8(value));

        memory.metadata.updated_timestamp = tx_context::epoch_timestamp_ms(ctx);
    }

    /// Comprehensive update for a memory record
    ///
    /// Updates multiple fields of a Memory object in a single transaction.
    /// Only non-empty values will be updated (empty vector<u8> = skip update).
    ///
    /// This function follows Sui's object model where:
    /// - Objects are passed as mutable references (&mut)
    /// - Version number is automatically incremented by Sui runtime
    /// - Changes are atomic within the transaction
    ///
    /// @param memory: Mutable reference to the Memory object
    /// @param new_blob_id: New Walrus blob ID (empty = no change)
    /// @param new_category: New category (empty = no change)
    /// @param new_topic: New topic (empty = no change)
    /// @param new_importance: New importance (0 = no change, 1-10 = update)
    /// @param new_embedding_blob_id: New embedding blob ID (empty = no change)
    /// @param new_content_hash: New content hash (empty = no change)
    /// @param new_content_size: New content size (0 = no change)
    /// @param ctx: Transaction context
    public entry fun update_memory_record(
        memory: &mut Memory,
        new_blob_id: vector<u8>,
        new_category: vector<u8>,
        new_topic: vector<u8>,
        new_importance: u8,
        new_embedding_blob_id: vector<u8>,
        new_content_hash: vector<u8>,
        new_content_size: u64,
        ctx: &tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == memory.owner, ENonOwner);

        let timestamp = tx_context::epoch_timestamp_ms(ctx);
        let mut updated_fields: u8 = 0;

        // Update blob_id if provided
        if (new_blob_id != b"") {
            memory.blob_id = string::utf8(new_blob_id);
            updated_fields = updated_fields | 1; // bit 0
        };

        // Update category if provided
        if (new_category != b"") {
            memory.category = string::utf8(new_category);
            memory.metadata.category = string::utf8(new_category);
            updated_fields = updated_fields | 2; // bit 1
        };

        // Update topic if provided
        if (new_topic != b"") {
            memory.metadata.topic = string::utf8(new_topic);
            updated_fields = updated_fields | 4; // bit 2
        };

        // Update importance if provided (0 means no change)
        if (new_importance > 0) {
            assert!(new_importance >= 1 && new_importance <= 10, EInvalidImportance);
            memory.metadata.importance = new_importance;
            updated_fields = updated_fields | 8; // bit 3
        };

        // Update embedding blob ID if provided
        if (new_embedding_blob_id != b"") {
            memory.metadata.embedding_blob_id = string::utf8(new_embedding_blob_id);
            updated_fields = updated_fields | 16; // bit 4
        };

        // Update content hash if provided
        if (new_content_hash != b"") {
            memory.metadata.content_hash = string::utf8(new_content_hash);
            updated_fields = updated_fields | 32; // bit 5
        };

        // Update content size if provided (0 means no change)
        if (new_content_size > 0) {
            memory.metadata.content_size = new_content_size;
            updated_fields = updated_fields | 64; // bit 6
        };

        // Always update timestamp
        memory.metadata.updated_timestamp = timestamp;

        // Emit update event
        sui::event::emit(MemoryUpdated {
            id: object::uid_to_inner(&memory.id),
            owner: memory.owner,
            updated_fields,
            new_blob_id: if (new_blob_id != b"") { option::some(string::utf8(new_blob_id)) } else { option::none() },
            new_category: if (new_category != b"") { option::some(string::utf8(new_category)) } else { option::none() },
            updated_at: timestamp,
        });
    }

    /// Update memory record with capability verification (V2)
    ///
    /// Same as update_memory_record but verifies the caller owns the associated MemoryCap.
    /// Use this for capability-based memories to ensure proper access control.
    ///
    /// @param cap: Reference to the MemoryCap (proves ownership)
    /// @param memory: Mutable reference to the Memory object
    /// @param new_blob_id: New Walrus blob ID (empty = no change)
    /// @param new_category: New category (empty = no change)
    /// @param new_topic: New topic (empty = no change)
    /// @param new_importance: New importance (0 = no change, 1-10 = update)
    /// @param new_embedding_blob_id: New embedding blob ID (empty = no change)
    /// @param new_content_hash: New content hash (empty = no change)
    /// @param new_content_size: New content size (0 = no change)
    /// @param ctx: Transaction context
    public entry fun update_memory_with_cap(
        cap: &pdw::capability::MemoryCap,
        memory: &mut Memory,
        new_blob_id: vector<u8>,
        new_category: vector<u8>,
        new_topic: vector<u8>,
        new_importance: u8,
        new_embedding_blob_id: vector<u8>,
        new_content_hash: vector<u8>,
        new_content_size: u64,
        ctx: &tx_context::TxContext
    ) {
        // Verify capability matches memory's capability_id
        let cap_id = pdw::capability::get_cap_id(cap);
        assert!(option::is_some(&memory.capability_id), ENonOwner);
        assert!(*option::borrow(&memory.capability_id) == cap_id, ENonOwner);

        let timestamp = tx_context::epoch_timestamp_ms(ctx);
        let mut updated_fields: u8 = 0;

        // Update blob_id if provided
        if (new_blob_id != b"") {
            memory.blob_id = string::utf8(new_blob_id);
            updated_fields = updated_fields | 1;
        };

        // Update category if provided
        if (new_category != b"") {
            memory.category = string::utf8(new_category);
            memory.metadata.category = string::utf8(new_category);
            updated_fields = updated_fields | 2;
        };

        // Update topic if provided
        if (new_topic != b"") {
            memory.metadata.topic = string::utf8(new_topic);
            updated_fields = updated_fields | 4;
        };

        // Update importance if provided
        if (new_importance > 0) {
            assert!(new_importance >= 1 && new_importance <= 10, EInvalidImportance);
            memory.metadata.importance = new_importance;
            updated_fields = updated_fields | 8;
        };

        // Update embedding blob ID if provided
        if (new_embedding_blob_id != b"") {
            memory.metadata.embedding_blob_id = string::utf8(new_embedding_blob_id);
            updated_fields = updated_fields | 16;
        };

        // Update content hash if provided
        if (new_content_hash != b"") {
            memory.metadata.content_hash = string::utf8(new_content_hash);
            updated_fields = updated_fields | 32;
        };

        // Update content size if provided
        if (new_content_size > 0) {
            memory.metadata.content_size = new_content_size;
            updated_fields = updated_fields | 64;
        };

        // Always update timestamp
        memory.metadata.updated_timestamp = timestamp;

        // Emit update event
        sui::event::emit(MemoryUpdated {
            id: object::uid_to_inner(&memory.id),
            owner: memory.owner,
            updated_fields,
            new_blob_id: if (new_blob_id != b"") { option::some(string::utf8(new_blob_id)) } else { option::none() },
            new_category: if (new_category != b"") { option::some(string::utf8(new_category)) } else { option::none() },
            updated_at: timestamp,
        });
    }

    /// Create a lightweight memory record (for use with Walrus metadata) - LEGACY
    ///
    /// This function creates a minimal on-chain Memory struct with only essential
    /// queryable fields. Rich metadata should be stored as Walrus blob metadata.
    ///
    /// Use this when:
    /// - Gas costs are a concern
    /// - Rich metadata is stored on Walrus blob
    /// - Only need basic filtering (category, vector_id)
    ///
    /// NOTE: For new implementations, use create_memory_lightweight_with_cap() instead
    public entry fun create_memory_record_lightweight(
        category: vector<u8>,
        vector_id: u64,
        blob_id: vector<u8>,
        blob_object_id: vector<u8>, // Optional: Walrus blob object ID for metadata queries
        importance: u8,
        ctx: &mut tx_context::TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let id = object::new(ctx);
        let object_id = object::uid_to_inner(&id);
        let timestamp = tx_context::epoch_timestamp_ms(ctx);

        // Validate importance
        assert!(importance >= 1 && importance <= 10, EInvalidImportance);

        // Create minimal metadata (detailed metadata on Walrus)
        let mut metadata = MemoryMetadata {
            content_type: string::utf8(b"application/octet-stream"),
            content_size: 0, // Size tracked on Walrus
            content_hash: string::utf8(b""), // blob_id serves as content hash
            category: string::utf8(category),
            topic: string::utf8(b""), // Topic on Walrus metadata
            importance,
            embedding_blob_id: string::utf8(b""), // Embedding blob ID on Walrus
            embedding_dimension: 768,
            created_timestamp: timestamp,
            updated_timestamp: timestamp,
            custom_metadata: vec_map::empty()
        };

        // Store Walrus blob object ID in custom metadata if provided
        if (blob_object_id != b"") {
            vec_map::insert(&mut metadata.custom_metadata,
                          string::utf8(b"walrus_blob_object_id"),
                          string::utf8(blob_object_id));
        };

        let memory = Memory {
            id,
            owner,
            category: string::utf8(category),
            vector_id,
            blob_id: string::utf8(blob_id),
            metadata,
            capability_id: option::none(),
            app_id: option::none(),  // Legacy: no app context
        };

        // Emit event
        sui::event::emit(MemoryCreated {
            id: object_id,
            owner,
            category: string::utf8(category),
            vector_id,
            capability_id: option::none(),
            app_id: option::none(),
        });

        transfer::transfer(memory, owner);
    }

    /// Create a lightweight memory record with capability-based access (V2 - RECOMMENDED)
    ///
    /// Gas-optimized version for capability-based access control.
    ///
    /// @param cap: Reference to the MemoryCap (proves ownership)
    /// @param category: Memory category
    /// @param vector_id: Links to HNSW index
    /// @param blob_id: Pointer to encrypted content on Walrus
    /// @param blob_object_id: Optional Walrus blob object ID
    /// @param importance: Importance scale (1-10)
    /// @param ctx: Transaction context
    public entry fun create_memory_lightweight_with_cap(
        cap: &pdw::capability::MemoryCap,
        category: vector<u8>,
        vector_id: u64,
        blob_id: vector<u8>,
        blob_object_id: vector<u8>,
        importance: u8,
        ctx: &mut tx_context::TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let id = object::new(ctx);
        let object_id = object::uid_to_inner(&id);
        let timestamp = tx_context::epoch_timestamp_ms(ctx);

        // Get capability info for linking
        let cap_id = pdw::capability::get_cap_id(cap);
        let cap_app_id = pdw::capability::get_app_id(cap);

        // Validate importance
        assert!(importance >= 1 && importance <= 10, EInvalidImportance);

        // Create minimal metadata
        let mut metadata = MemoryMetadata {
            content_type: string::utf8(b"application/octet-stream"),
            content_size: 0,
            content_hash: string::utf8(b""),
            category: string::utf8(category),
            topic: string::utf8(b""),
            importance,
            embedding_blob_id: string::utf8(b""),
            embedding_dimension: 768,
            created_timestamp: timestamp,
            updated_timestamp: timestamp,
            custom_metadata: vec_map::empty()
        };

        // Store Walrus blob object ID if provided
        if (blob_object_id != b"") {
            vec_map::insert(&mut metadata.custom_metadata,
                          string::utf8(b"walrus_blob_object_id"),
                          string::utf8(blob_object_id));
        };

        let memory = Memory {
            id,
            owner,
            category: string::utf8(category),
            vector_id,
            blob_id: string::utf8(blob_id),
            metadata,
            capability_id: option::some(cap_id),
            app_id: option::some(cap_app_id),  // Copy app_id for context-based querying
        };

        // Emit event
        sui::event::emit(MemoryCreated {
            id: object_id,
            owner,
            category: string::utf8(category),
            vector_id,
            capability_id: option::some(cap_id),
            app_id: option::some(cap_app_id),
        });

        transfer::transfer(memory, owner);
    }

    /// Delete a memory record
    public entry fun delete_memory_record(
        memory: Memory,
        ctx: &tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == memory.owner, ENonOwner);

        // Emit deletion event
        sui::event::emit(MemoryCreated {
            id: object::uid_to_inner(&memory.id),
            owner: memory.owner,
            category: memory.category,
            vector_id: memory.vector_id,
            capability_id: memory.capability_id,
            app_id: memory.app_id,
        });

        // Delete the memory object
        let Memory { id, owner: _, category: _, vector_id: _, blob_id: _, metadata: _, capability_id: _, app_id: _ } = memory;
        object::delete(id);
    }

    // Accessor functions for MemoryIndex
    public fun get_index_blob_id(memory_index: &MemoryIndex): &String {
        &memory_index.index_blob_id
    }

    public fun get_graph_blob_id(memory_index: &MemoryIndex): &String {
        &memory_index.graph_blob_id
    }

    public fun get_version(memory_index: &MemoryIndex): u64 {
        memory_index.version
    }

    // Accessor functions for Memory
    public fun get_memory_blob_id(memory: &Memory): &String {
        &memory.blob_id
    }

    public fun get_memory_vector_id(memory: &Memory): u64 {
        memory.vector_id
    }

    public fun get_memory_category(memory: &Memory): &String {
        &memory.category
    }

    // Accessor functions for MemoryMetadata
    public fun get_metadata(memory: &Memory): &MemoryMetadata {
        &memory.metadata
    }

    public fun get_embedding_blob_id(metadata: &MemoryMetadata): &String {
        &metadata.embedding_blob_id
    }

    public fun get_content_type(metadata: &MemoryMetadata): &String {
        &metadata.content_type
    }

    public fun get_content_size(metadata: &MemoryMetadata): u64 {
        metadata.content_size
    }

    public fun get_topic(metadata: &MemoryMetadata): &String {
        &metadata.topic
    }

    public fun get_importance(metadata: &MemoryMetadata): u8 {
        metadata.importance
    }

    public fun get_created_timestamp(metadata: &MemoryMetadata): u64 {
        metadata.created_timestamp
    }

    public fun get_updated_timestamp(metadata: &MemoryMetadata): u64 {
        metadata.updated_timestamp
    }

    public fun get_custom_metadata(metadata: &MemoryMetadata): &VecMap<String, String> {
        &metadata.custom_metadata
    }

    // V2: Capability-related accessor functions

    /// Get the capability_id from a memory (if linked to a MemoryCap)
    public fun get_capability_id(memory: &Memory): Option<address> {
        memory.capability_id
    }

    /// Check if memory is linked to a capability (V2)
    public fun has_capability(memory: &Memory): bool {
        option::is_some(&memory.capability_id)
    }

    /// Check if memory is using legacy owner-based access
    public fun is_legacy_access(memory: &Memory): bool {
        option::is_none(&memory.capability_id)
    }

    /// Get the app_id from a memory (for context-based querying)
    /// Returns None for legacy memories without capability
    public fun get_app_id(memory: &Memory): Option<String> {
        memory.app_id
    }

    /// Check if memory belongs to a specific app context
    public fun is_app_context(memory: &Memory, app_id: &String): bool {
        if (option::is_some(&memory.app_id)) {
            let mem_app_id = option::borrow(&memory.app_id);
            mem_app_id == app_id
        } else {
            false
        }
    }
}