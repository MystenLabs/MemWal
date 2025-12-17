/**
 * MemoryPipeline - Unified Memory Processing Pipeline
 * 
 * Orchestrates the complete memory processing workflow:
 * Memory Input → AI Embedding → Vector Indexing → Knowledge Graph → Walrus Storage → Sui Blockchain
 * 
 * Provides comprehensive error handling, rollback capabilities, and monitoring.
 */

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorManager } from '../vector/VectorManager';
import { StorageService } from '../services/StorageService';
import { BatchManager } from '../batch/BatchManager';
import { KnowledgeGraphManager } from '../graph/KnowledgeGraphManager';
import { StorageManager } from '../infrastructure/walrus/StorageManager';
import { BlockchainManager } from '../infrastructure/sui/BlockchainManager';
import { Memory, ProcessedMemory, MemoryPipelineConfig, MemoryPipelineResult } from '../embedding/types';

export interface PipelineConfig {
  // Service configurations
  embedding?: {
    apiKey?: string;
    model?: string;
    enableBatching?: boolean;
    batchSize?: number;
  };
  vector?: {
    dimensions?: number;
    maxElements?: number;
    enablePersistence?: boolean;
  };
  batch?: {
    enableBatching?: boolean;
    batchSize?: number;
    batchDelayMs?: number;
  };
  graph?: {
    enableExtraction?: boolean;
    confidenceThreshold?: number;
    enableEmbeddings?: boolean;
  };
  storage?: {
    enableEncryption?: boolean;
    enableBatching?: boolean;
    network?: 'testnet' | 'mainnet';
  };
  blockchain?: {
    enableOwnershipTracking?: boolean;
    enableBatching?: boolean;
    network?: 'testnet' | 'mainnet';
    packageId?: string;
  };
  // Pipeline behavior
  enableRollback?: boolean;
  enableMonitoring?: boolean;
  skipFailedSteps?: boolean;
  maxRetryAttempts?: number;
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  startTime?: Date;
  endTime?: Date;
  processingTimeMs?: number;
  result?: any;
  error?: string;
  retryAttempts?: number;
}

export interface PipelineExecution {
  id: string;
  userId: string;
  memoryId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'rolled_back';
  steps: PipelineStep[];
  startTime: Date;
  endTime?: Date;
  totalProcessingTime?: number;
  result?: ProcessedMemory;
  error?: string;
  rollbackReason?: string;
}

export interface PipelineMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  rolledBackExecutions: number;
  averageProcessingTime: number;
  stepMetrics: Record<string, {
    successCount: number;
    failureCount: number;
    averageProcessingTime: number;
    lastFailure?: string;
  }>;
  throughput: {
    memoriesPerHour: number;
    peakThroughput: number;
    currentLoad: number;
  };
}

export interface RollbackInfo {
  stepName: string;
  reason: string;
  rollbackActions: string[];
  completedActions: string[];
  failedActions: string[];
}

/**
 * Complete memory processing pipeline with orchestrated services
 */
export class MemoryPipeline {
  private embeddingService!: EmbeddingService;
  private vectorManager!: VectorManager;
  private batchManager!: BatchManager;
  private graphManager!: KnowledgeGraphManager;
  private storageManager!: StorageManager;
  private blockchainManager!: BlockchainManager;
  
  private readonly config: Required<PipelineConfig>;
  private executions = new Map<string, PipelineExecution>();
  private metrics: PipelineMetrics = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    rolledBackExecutions: 0,
    averageProcessingTime: 0,
    stepMetrics: {},
    throughput: {
      memoriesPerHour: 0,
      peakThroughput: 0,
      currentLoad: 0
    }
  };

  private readonly PIPELINE_STEPS = [
    'embedding_generation',
    'vector_indexing', 
    'knowledge_graph_extraction',
    'walrus_storage',
    'blockchain_record'
  ];

  constructor(config: PipelineConfig = {}) {
    this.config = {
      embedding: {
        apiKey: config.embedding?.apiKey || '',
        model: config.embedding?.model || process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
        enableBatching: config.embedding?.enableBatching !== false,
        batchSize: config.embedding?.batchSize || 20
      },
      vector: {
        dimensions: config.vector?.dimensions || 3072,
        maxElements: config.vector?.maxElements || 10000,
        enablePersistence: config.vector?.enablePersistence !== false
      },
      batch: {
        enableBatching: config.batch?.enableBatching !== false,
        batchSize: config.batch?.batchSize || 50,
        batchDelayMs: config.batch?.batchDelayMs || 5000
      },
      graph: {
        enableExtraction: config.graph?.enableExtraction !== false,
        confidenceThreshold: config.graph?.confidenceThreshold || 0.7,
        enableEmbeddings: config.graph?.enableEmbeddings !== false
      },
      storage: {
        enableEncryption: config.storage?.enableEncryption !== false,
        enableBatching: config.storage?.enableBatching !== false,
        network: config.storage?.network || 'testnet'
      },
      blockchain: {
        enableOwnershipTracking: config.blockchain?.enableOwnershipTracking !== false,
        enableBatching: config.blockchain?.enableBatching !== false,
        network: config.blockchain?.network || 'testnet',
        packageId: config.blockchain?.packageId
      },
      enableRollback: config.enableRollback !== false,
      enableMonitoring: config.enableMonitoring !== false,
      skipFailedSteps: config.skipFailedSteps || false,
      maxRetryAttempts: config.maxRetryAttempts || 3
    };

    this.initializeServices();
    this.initializeStepMetrics();
  }

  // ==================== PIPELINE EXECUTION ====================

  /**
   * Process memory through complete pipeline
   */
  async processMemory(
    memory: Memory,
    userId: string,
    options: {
      skipSteps?: string[];
      priority?: 'low' | 'normal' | 'high';
      enableRollback?: boolean;
      customMetadata?: Record<string, string>;
    } = {}
  ): Promise<PipelineExecution> {
    const executionId = this.generateExecutionId();
    
    // Create execution record
    const execution: PipelineExecution = {
      id: executionId,
      userId,
      memoryId: memory.id,
      status: 'pending',
      steps: this.initializeSteps(options.skipSteps),
      startTime: new Date()
    };

    this.executions.set(executionId, execution);
    this.metrics.totalExecutions++;

    try {
      execution.status = 'processing';
      console.log(`🔄 Starting pipeline execution for memory: ${memory.id}`);

      let processedMemory: ProcessedMemory = {
        ...memory,
        processedAt: new Date()
      };

      // Step 1: Embedding Generation
      if (this.shouldExecuteStep('embedding_generation', options.skipSteps)) {
        processedMemory = await this.executeEmbeddingStep(execution, processedMemory);
      }

      // Step 2: Vector Indexing  
      if (this.shouldExecuteStep('vector_indexing', options.skipSteps)) {
        processedMemory = await this.executeVectorIndexingStep(execution, processedMemory);
      }

      // Step 3: Knowledge Graph Extraction
      if (this.shouldExecuteStep('knowledge_graph_extraction', options.skipSteps)) {
        processedMemory = await this.executeKnowledgeGraphStep(execution, processedMemory, userId);
      }

      // Step 4: Walrus Storage
      if (this.shouldExecuteStep('walrus_storage', options.skipSteps)) {
        processedMemory = await this.executeStorageStep(execution, processedMemory, userId, options);
      }

      // Step 5: Blockchain Record
      if (this.shouldExecuteStep('blockchain_record', options.skipSteps)) {
        processedMemory = await this.executeBlockchainStep(execution, processedMemory, userId, options);
      }

      // Pipeline completed successfully
      execution.status = 'completed';
      execution.endTime = new Date();
      execution.totalProcessingTime = execution.endTime.getTime() - execution.startTime.getTime();
      execution.result = processedMemory;

      this.metrics.successfulExecutions++;
      this.updateThroughputMetrics();
      this.updateAverageProcessingTime(execution.totalProcessingTime);

      console.log(`✅ Pipeline completed successfully for memory: ${memory.id} (${execution.totalProcessingTime}ms)`);
      
      return execution;

    } catch (error) {
      console.error(`❌ Pipeline failed for memory: ${memory.id}`, error);
      
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);
      execution.endTime = new Date();

      // Attempt rollback if enabled
      if (options.enableRollback !== false && this.config.enableRollback) {
        await this.attemptRollback(execution);
      }

      this.metrics.failedExecutions++;
      
      return execution;
    }
  }

  /**
   * Process multiple memories in batch
   */
  async processMemoriesBatch(
    memories: Memory[],
    userId: string,
    options: {
      batchSize?: number;
      skipSteps?: string[];
      priority?: 'low' | 'normal' | 'high';
      onProgress?: (completed: number, total: number, current?: PipelineExecution) => void;
      enableParallel?: boolean;
    } = {}
  ): Promise<PipelineExecution[]> {
    const batchSize = options.batchSize || 5;
    const results: PipelineExecution[] = [];

    console.log(`🔄 Starting batch processing of ${memories.length} memories`);

    if (options.enableParallel) {
      // Process all memories in parallel (use with caution for large batches)
      const promises = memories.map(memory => 
        this.processMemory(memory, userId, {
          skipSteps: options.skipSteps,
          priority: options.priority
        })
      );
      
      const batchResults = await Promise.allSettled(promises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error('Batch memory processing failed:', result.reason);
        }
      }
    } else {
      // Process in sequential batches
      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);
        
        for (const memory of batch) {
          try {
            const execution = await this.processMemory(memory, userId, {
              skipSteps: options.skipSteps,
              priority: options.priority
            });
            
            results.push(execution);
            
            // Progress callback
            if (options.onProgress) {
              options.onProgress(results.length, memories.length, execution);
            }
          } catch (error) {
            console.error(`Failed to process memory ${memory.id}:`, error);
          }
        }

        // Small delay between batches to prevent overwhelming
        if (i + batchSize < memories.length) {
          await this.delay(100);
        }
      }
    }

    console.log(`✅ Batch processing completed: ${results.filter(r => r.status === 'completed').length}/${memories.length} successful`);
    
    return results;
  }

  // ==================== PIPELINE MONITORING ====================

  /**
   * Get execution status
   */
  getExecutionStatus(executionId: string): PipelineExecution | null {
    return this.executions.get(executionId) || null;
  }

  /**
   * Get all executions for user
   */
  getUserExecutions(userId: string): PipelineExecution[] {
    return Array.from(this.executions.values())
      .filter(execution => execution.userId === userId);
  }

  /**
   * Get pipeline metrics
   */
  getPipelineMetrics(): PipelineMetrics {
    return { ...this.metrics };
  }

  /**
   * Get active executions
   */
  getActiveExecutions(): PipelineExecution[] {
    return Array.from(this.executions.values())
      .filter(execution => execution.status === 'processing');
  }

  /**
   * Get failed executions
   */
  getFailedExecutions(limit?: number): PipelineExecution[] {
    const failed = Array.from(this.executions.values())
      .filter(execution => execution.status === 'failed')
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
    
    return limit ? failed.slice(0, limit) : failed;
  }

  // ==================== PIPELINE MANAGEMENT ====================

  /**
   * Retry failed execution
   */
  async retryExecution(executionId: string): Promise<PipelineExecution | null> {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'failed') {
      return null;
    }

    // Find the failed step and retry from there
    const failedStepIndex = execution.steps.findIndex(step => step.status === 'failed');
    if (failedStepIndex === -1) {
      return null;
    }

    // Reset steps from failed point
    for (let i = failedStepIndex; i < execution.steps.length; i++) {
      execution.steps[i].status = 'pending';
      execution.steps[i].error = undefined;
      execution.steps[i].retryAttempts = (execution.steps[i].retryAttempts || 0) + 1;
    }

    // Retry execution (simplified - in production, implement proper retry logic)
    console.log(`🔄 Retrying execution ${executionId} from step: ${execution.steps[failedStepIndex].name}`);
    
    return execution;
  }

  /**
   * Cancel active execution
   */
  async cancelExecution(executionId: string): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'processing') {
      return false;
    }

    execution.status = 'failed';
    execution.error = 'Execution cancelled by user';
    execution.endTime = new Date();

    console.log(`⏹️ Cancelled execution: ${executionId}`);
    return true;
  }

  /**
   * Clear completed executions
   */
  clearCompletedExecutions(): number {
    const beforeSize = this.executions.size;
    
    for (const [id, execution] of this.executions.entries()) {
      if (execution.status === 'completed' || execution.status === 'failed') {
        this.executions.delete(id);
      }
    }

    const cleared = beforeSize - this.executions.size;
    console.log(`🧹 Cleared ${cleared} completed/failed executions`);
    
    return cleared;
  }

  /**
   * Get pipeline health status
   */
  getPipelineHealth(): {
    status: 'healthy' | 'degraded' | 'critical';
    activeExecutions: number;
    successRate: number;
    averageProcessingTime: number;
    issues: string[];
  } {
    const successRate = this.metrics.totalExecutions > 0 
      ? this.metrics.successfulExecutions / this.metrics.totalExecutions 
      : 1;

    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

    // Check success rate
    if (successRate < 0.8) {
      issues.push('Low success rate detected');
      status = 'degraded';
    }
    if (successRate < 0.5) {
      status = 'critical';
    }

    // Check processing time
    if (this.metrics.averageProcessingTime > 30000) { // 30 seconds
      issues.push('High average processing time');
      if (status === 'healthy') status = 'degraded';
    }

    // Check active executions
    const activeCount = this.getActiveExecutions().length;
    if (activeCount > 20) {
      issues.push('High number of active executions');
      if (status === 'healthy') status = 'degraded';
    }

    return {
      status,
      activeExecutions: activeCount,
      successRate,
      averageProcessingTime: this.metrics.averageProcessingTime,
      issues
    };
  }

  // ==================== PRIVATE METHODS ====================

  private initializeServices(): void {
    // Initialize all services with configurations
    this.embeddingService = new EmbeddingService({
      apiKey: this.config.embedding.apiKey,
      model: this.config.embedding.model,
      requestsPerMinute: 60
    });

    this.vectorManager = new VectorManager({
      embedding: { apiKey: '' },
      index: {
        dimension: this.config.vector.dimensions,
        maxElements: this.config.vector.maxElements
      },
      batch: { maxBatchSize: 10 }
    });

    this.batchManager = new BatchManager({
      embedding: {
        batchSize: this.config.batch.batchSize,
        delayMs: this.config.batch.batchDelayMs
      },
      enableMetrics: this.config.enableMonitoring
    });

    this.graphManager = new KnowledgeGraphManager();

    this.storageManager = new StorageManager({
      walrusConfig: {
        network: this.config.storage.network,
        enableEncryption: this.config.storage.enableEncryption,
        enableBatching: this.config.storage.enableBatching
      }
    });

    this.blockchainManager = new BlockchainManager({
      suiConfig: {
        network: this.config.blockchain.network,
        packageId: this.config.blockchain.packageId,
        enableBatching: this.config.blockchain.enableBatching
      }
    });

    // Initialize batch manager with services
    this.batchManager.initialize({
      embeddingService: this.embeddingService,
      indexService: this.vectorManager['indexService'] ?? undefined // Access private member
    });
  }

  private initializeSteps(skipSteps?: string[]): PipelineStep[] {
    return this.PIPELINE_STEPS.map(stepName => ({
      name: stepName,
      status: skipSteps?.includes(stepName) ? 'skipped' : 'pending'
    }));
  }

  private initializeStepMetrics(): void {
    for (const stepName of this.PIPELINE_STEPS) {
      this.metrics.stepMetrics[stepName] = {
        successCount: 0,
        failureCount: 0,
        averageProcessingTime: 0,
      };
    }
  }

  private shouldExecuteStep(stepName: string, skipSteps?: string[]): boolean {
    return !skipSteps?.includes(stepName);
  }

  private async executeEmbeddingStep(
    execution: PipelineExecution, 
    memory: ProcessedMemory
  ): Promise<ProcessedMemory> {
    const step = this.findStep(execution, 'embedding_generation');
    return this.executeStep(step, async () => {
      console.log(`📊 Generating embedding for memory: ${memory.id}`);
      
      const result = await this.embeddingService.embedText({
        text: memory.content,
        type: 'content'
      });
      
      if (!result.vector) {
        throw new Error('Embedding generation failed: No vector returned');
      }

      return {
        ...memory,
        embedding: result.vector,
        embeddingModel: 'gemini-embedding'
      };
    });
  }

  private async executeVectorIndexingStep(
    execution: PipelineExecution,
    memory: ProcessedMemory  
  ): Promise<ProcessedMemory> {
    const step = this.findStep(execution, 'vector_indexing');
    return this.executeStep(step, async () => {
      console.log(`🔍 Adding to vector index: ${memory.id}`);
      
      if (!memory.embedding) {
        throw new Error('No embedding available for indexing');
      }

      const vectorResult = await this.vectorManager.addTextToIndex(
        memory.userId || 'default-user',
        memory.content,
        {
          vectorId: parseInt(memory.id) || Date.now(),
          metadata: {
            content: memory.content,
            category: memory.category,
            timestamp: memory.createdAt
          }
        }
      );

      const vectorId = vectorResult.vectorId;

      return {
        ...memory,
        vectorId
      };
    });
  }

  private async executeKnowledgeGraphStep(
    execution: PipelineExecution,
    memory: ProcessedMemory,
    userId: string
  ): Promise<ProcessedMemory> {
    const step = this.findStep(execution, 'knowledge_graph_extraction');
    return this.executeStep(step, async () => {
      console.log(`🧠 Extracting knowledge graph for memory: ${memory.id}`);
      
      const result = await this.graphManager.processMemoryForGraph(memory, userId, {
        confidenceThreshold: this.config.graph.confidenceThreshold
      });

      if (!result.success) {
        console.warn(`Knowledge graph extraction failed: ${result.error}`);
        // Non-critical failure, continue pipeline
      }

      return memory;
    });
  }

  private async executeStorageStep(
    execution: PipelineExecution,
    memory: ProcessedMemory,
    userId: string,
    options: any
  ): Promise<ProcessedMemory> {
    const step = this.findStep(execution, 'walrus_storage');
    return this.executeStep(step, async () => {
      console.log(`💾 Storing memory on Walrus: ${memory.id}`);
      
      const result = await this.storageManager.storeMemory(memory, userId, {
        enableEncryption: this.config.storage.enableEncryption,
        customMetadata: options.customMetadata
      });

      if (!result.success) {
        throw new Error(`Storage failed: ${result.error}`);
      }

      return {
        ...memory,
        blobId: result.blobId
      };
    });
  }

  private async executeBlockchainStep(
    execution: PipelineExecution,
    memory: ProcessedMemory,
    userId: string,
    options: any
  ): Promise<ProcessedMemory> {
    const step = this.findStep(execution, 'blockchain_record');
    return this.executeStep(step, async () => {
      console.log(`⛓️ Creating blockchain record for memory: ${memory.id}`);
      
      const ownershipRecord = await this.blockchainManager.createMemoryRecord(
        memory,
        userId,
        {
          enableBatching: this.config.blockchain.enableBatching,
          customMetadata: options.customMetadata
        }
      );

      return {
        ...memory,
        blockchainRecordId: ownershipRecord.blockchainRecordId
      };
    });
  }

  private async executeStep<T>(
    step: PipelineStep,
    operation: () => Promise<T>
  ): Promise<T> {
    step.status = 'processing';
    step.startTime = new Date();

    try {
      const result = await operation();
      
      step.status = 'completed';
      step.endTime = new Date();
      step.processingTimeMs = step.endTime.getTime() - step.startTime.getTime();
      step.result = result;

      // Update metrics
      const stepMetric = this.metrics.stepMetrics[step.name];
      if (stepMetric) {
        stepMetric.successCount++;
        stepMetric.averageProcessingTime = 
          (stepMetric.averageProcessingTime + step.processingTimeMs) / stepMetric.successCount;
      }

      return result;

    } catch (error) {
      step.status = 'failed';
      step.endTime = new Date();
      step.processingTimeMs = step.endTime!.getTime() - step.startTime.getTime();
      step.error = error instanceof Error ? error.message : String(error);

      // Update metrics
      const stepMetric = this.metrics.stepMetrics[step.name];
      if (stepMetric) {
        stepMetric.failureCount++;
        stepMetric.lastFailure = step.error;
      }

      throw error;
    }
  }

  private findStep(execution: PipelineExecution, stepName: string): PipelineStep {
    const step = execution.steps.find(s => s.name === stepName);
    if (!step) {
      throw new Error(`Step not found: ${stepName}`);
    }
    return step;
  }

  private async attemptRollback(execution: PipelineExecution): Promise<void> {
    console.log(`🔄 Attempting rollback for execution: ${execution.id}`);
    
    try {
      // Find completed steps that need rollback
      const completedSteps = execution.steps.filter(step => step.status === 'completed');
      
      // Rollback in reverse order
      for (let i = completedSteps.length - 1; i >= 0; i--) {
        const step = completedSteps[i];
        await this.rollbackStep(step);
      }

      execution.status = 'rolled_back';
      execution.rollbackReason = execution.error;
      this.metrics.rolledBackExecutions++;
      
      console.log(`✅ Rollback completed for execution: ${execution.id}`);
      
    } catch (rollbackError) {
      console.error(`❌ Rollback failed for execution: ${execution.id}`, rollbackError);
      // Execution remains in failed state
    }
  }

  private async rollbackStep(step: PipelineStep): Promise<void> {
    console.log(`🔙 Rolling back step: ${step.name}`);
    
    // Implement step-specific rollback logic
    try {
      switch (step.name) {
        case 'walrus_storage':
          // Delete stored blob if possible
          if (step.result?.blobId) {
            await this.storageManager.deleteMemory(step.result.blobId);
          }
          break;
        
        case 'blockchain_record':
          // Cannot rollback blockchain transactions, but mark as noted
          console.log(`⚠️ Cannot rollback blockchain transaction for step: ${step.name}`);
          break;
        
        default:
          // Most steps don't require explicit rollback
          break;
      }
      
      console.log(`✅ Rollback completed for step: ${step.name}`);
      
    } catch (error) {
      console.error(`❌ Rollback failed for step: ${step.name}`, error);
      throw error;
    }
  }

  private updateThroughputMetrics(): void {
    // Calculate memories per hour based on recent completions
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const recentCompletions = Array.from(this.executions.values())
      .filter(exec => 
        exec.status === 'completed' && 
        exec.endTime && 
        exec.endTime.getTime() > oneHourAgo
      );

    this.metrics.throughput.memoriesPerHour = recentCompletions.length;
    this.metrics.throughput.currentLoad = this.getActiveExecutions().length;
    
    // Update peak if current is higher
    if (recentCompletions.length > this.metrics.throughput.peakThroughput) {
      this.metrics.throughput.peakThroughput = recentCompletions.length;
    }
  }

  private updateAverageProcessingTime(processingTime: number): void {
    const totalSuccessful = this.metrics.successfulExecutions;
    this.metrics.averageProcessingTime = 
      (this.metrics.averageProcessingTime * (totalSuccessful - 1) + processingTime) / totalSuccessful;
  }

  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MemoryPipeline;