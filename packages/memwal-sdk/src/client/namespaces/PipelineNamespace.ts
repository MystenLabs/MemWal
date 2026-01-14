/**
 * Pipeline Namespace - Memory Processing Pipelines
 *
 * Pure delegation to PipelineManager for orchestrated workflows.
 * Manages multi-step memory processing pipelines.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type {
  PipelineConfig,
  PipelineExecution
} from '../../pipeline/MemoryPipeline';
import type { ManagedPipeline } from '../../pipeline/PipelineManager';
import type { Memory } from '../../embedding/types';

/**
 * Pipeline information
 */
export interface PipelineInfo {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'stopped';
  executionCount: number;
  createdAt: Date;
}

/**
 * Pipeline Namespace
 *
 * Handles memory processing pipeline orchestration
 */
export class PipelineNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Create a new processing pipeline
   *
   * Delegates to: PipelineManager.createPipeline()
   *
   * @param name - Pipeline name
   * @param config - Pipeline configuration
   * @returns Pipeline ID
   */
  create(name: string, config: PipelineConfig = {}): string {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return this.services.pipeline.createPipeline(name, config, {
      autoStart: true
    });
  }

  /**
   * Execute pipeline with input memory
   *
   * Delegates to: PipelineManager.processMemory()
   *
   * @param pipelineId - Pipeline ID
   * @param input - Memory input data
   * @returns Pipeline execution result
   */
  async execute(pipelineId: string, input: Memory): Promise<PipelineExecution> {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return await this.services.pipeline.processMemory(
      pipelineId,
      input,
      this.services.config.userAddress
    );
  }

  /**
   * List all pipelines
   *
   * Delegates to: PipelineManager.listPipelines()
   *
   * @returns Array of pipeline info
   */
  list(): PipelineInfo[] {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    const pipelines = this.services.pipeline.listPipelines();

    return pipelines.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status,
      executionCount: p.executionCount,
      createdAt: p.createdAt
    }));
  }

  /**
   * Get pipeline details
   *
   * Delegates to: PipelineManager.getPipeline()
   *
   * @param pipelineId - Pipeline ID
   * @returns Pipeline details
   */
  get(pipelineId: string): ManagedPipeline | null {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return this.services.pipeline.getPipeline(pipelineId);
  }

  /**
   * Update pipeline (pause/resume)
   *
   * Delegates to: PipelineManager.pausePipeline() / startPipeline()
   *
   * @param pipelineId - Pipeline ID
   * @param updates - Updates to apply
   * @returns Success status
   */
  update(pipelineId: string, updates: { status?: 'active' | 'paused' }): boolean {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    if (updates.status === 'paused') {
      return this.services.pipeline.pausePipeline(pipelineId);
    } else if (updates.status === 'active') {
      return this.services.pipeline.startPipeline(pipelineId);
    }

    return false;
  }

  /**
   * Delete pipeline
   *
   * Delegates to: PipelineManager.removePipeline()
   *
   * @param pipelineId - Pipeline ID
   * @returns Success status
   */
  delete(pipelineId: string): boolean {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return this.services.pipeline.removePipeline(pipelineId);
  }

  /**
   * Create pipeline from template
   *
   * Delegates to: PipelineManager.createPipelineFromTemplate()
   *
   * @param templateName - Template name
   * @param customName - Custom pipeline name
   * @returns Pipeline ID
   */
  createFromTemplate(templateName: string, customName: string): string {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return this.services.pipeline.createPipelineFromTemplate(
      templateName,
      customName
    );
  }

  /**
   * Get available templates
   *
   * Delegates to: PipelineManager.getPipelineTemplates()
   *
   * @returns Array of templates
   */
  getTemplates(): Array<{ name: string; description: string; category: string }> {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    return this.services.pipeline.getPipelineTemplates().map(t => ({
      name: t.name,
      description: t.description,
      category: t.category
    }));
  }

  /**
   * Get pipeline metrics
   *
   * Delegates to: PipelineManager.getSystemMetrics()
   *
   * @returns System metrics
   */
  getMetrics(): {
    totalPipelines: number;
    activePipelines: number;
    totalExecutions: number;
    successRate: number;
  } {
    if (!this.services.pipeline) {
      throw new Error('Pipeline manager not configured.');
    }

    const metrics = this.services.pipeline.getSystemMetrics();

    return {
      totalPipelines: metrics.totalPipelines,
      activePipelines: metrics.activePipelines,
      totalExecutions: metrics.totalExecutions,
      successRate: metrics.performance.successRate
    };
  }
}
