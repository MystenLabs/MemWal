/**
 * Pipeline Module
 * 
 * Complete memory processing pipeline orchestrating:
 * Memory → AI Embedding → Vector Indexing → Knowledge Graph → Walrus Storage → Sui Blockchain
 * 
 * Provides unified processing, comprehensive monitoring, and high-level management.
 */

export { MemoryPipeline } from './MemoryPipeline';
export { PipelineManager } from './PipelineManager';

export type {
  PipelineConfig,
  PipelineStep,
  PipelineExecution,
  PipelineMetrics,
  RollbackInfo
} from './MemoryPipeline';

export type {
  PipelineManagerConfig,
  ManagedPipeline,
  PipelineSchedule,
  SystemMetrics,
  PipelineTemplate
} from './PipelineManager';