/**
 * PipelineManager - High-Level Pipeline Orchestration
 * 
 * Manages multiple pipeline instances, provides scheduling, monitoring,
 * and administration capabilities for memory processing workflows.
 */

import { MemoryPipeline, PipelineConfig, PipelineExecution } from './MemoryPipeline';
import { Memory } from '../embedding/types';

export interface PipelineManagerConfig {
  maxConcurrentPipelines?: number;
  defaultPipelineConfig?: PipelineConfig;
  enableScheduling?: boolean;
  enableHealthChecks?: boolean;
  healthCheckIntervalMs?: number;
  enableMetricsCollection?: boolean;
  metricsRetentionDays?: number;
}

export interface ManagedPipeline {
  id: string;
  name: string;
  pipeline: MemoryPipeline;
  config: PipelineConfig;
  status: 'active' | 'paused' | 'stopped';
  createdAt: Date;
  lastUsed: Date;
  executionCount: number;
}

export interface PipelineSchedule {
  id: string;
  pipelineId: string;
  userId: string;
  memories: Memory[];
  scheduledAt: Date;
  priority: 'low' | 'normal' | 'high';
  status: 'scheduled' | 'running' | 'completed' | 'failed';
  result?: PipelineExecution[];
}

export interface SystemMetrics {
  totalPipelines: number;
  activePipelines: number;
  totalExecutions: number;
  activeExecutions: number;
  systemLoad: number;
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  performance: {
    averageExecutionTime: number;
    throughput: number;
    successRate: number;
  };
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
    lastCheck: Date;
  };
}

export interface PipelineTemplate {
  name: string;
  description: string;
  config: PipelineConfig;
  category: 'basic' | 'advanced' | 'custom';
  tags: string[];
}

/**
 * High-level pipeline management and orchestration
 */
export class PipelineManager {
  private pipelines = new Map<string, ManagedPipeline>();
  private schedules = new Map<string, PipelineSchedule>();
  private healthCheckTimer?: NodeJS.Timeout;
  
  private readonly config: Required<PipelineManagerConfig>;
  private systemMetrics: SystemMetrics = {
    totalPipelines: 0,
    activePipelines: 0,
    totalExecutions: 0,
    activeExecutions: 0,
    systemLoad: 0,
    memoryUsage: { used: 0, total: 0, percentage: 0 },
    performance: { averageExecutionTime: 0, throughput: 0, successRate: 0 },
    health: { status: 'healthy', issues: [], lastCheck: new Date() }
  };

  private readonly PIPELINE_TEMPLATES: PipelineTemplate[] = [
    {
      name: 'Basic Memory Processing',
      description: 'Simple memory processing with embedding and storage',
      category: 'basic',
      tags: ['embedding', 'storage'],
      config: {
        embedding: { enableBatching: true, batchSize: 10 },
        storage: { enableEncryption: false },
        blockchain: { enableOwnershipTracking: false }
      }
    },
    {
      name: 'Full Decentralized Pipeline',
      description: 'Complete pipeline with all features enabled',
      category: 'advanced', 
      tags: ['embedding', 'vector', 'graph', 'storage', 'blockchain'],
      config: {
        embedding: { enableBatching: true, batchSize: 20 },
        vector: { enablePersistence: true },
        graph: { enableExtraction: true, confidenceThreshold: 0.7 },
        storage: { enableEncryption: true, enableBatching: true },
        blockchain: { enableOwnershipTracking: true, enableBatching: true }
      }
    },
    {
      name: 'High-Performance Batch Processing',
      description: 'Optimized for high-throughput batch processing',
      category: 'advanced',
      tags: ['batch', 'performance', 'throughput'],
      config: {
        embedding: { enableBatching: true, batchSize: 50 },
        batch: { enableBatching: true, batchSize: 100, batchDelayMs: 2000 },
        vector: { maxElements: 50000 },
        skipFailedSteps: true,
        maxRetryAttempts: 1
      }
    }
  ];

  constructor(config: PipelineManagerConfig = {}) {
    this.config = {
      maxConcurrentPipelines: config.maxConcurrentPipelines || 10,
      defaultPipelineConfig: config.defaultPipelineConfig || {},
      enableScheduling: config.enableScheduling !== false,
      enableHealthChecks: config.enableHealthChecks !== false,
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000, // 30 seconds
      enableMetricsCollection: config.enableMetricsCollection !== false,
      metricsRetentionDays: config.metricsRetentionDays || 7
    };

    this.startHealthChecks();
  }

  // ==================== PIPELINE MANAGEMENT ====================

  /**
   * Create a new managed pipeline
   */
  createPipeline(
    name: string,
    config: PipelineConfig = {},
    options: {
      autoStart?: boolean;
      description?: string;
    } = {}
  ): string {
    if (this.pipelines.size >= this.config.maxConcurrentPipelines) {
      throw new Error(`Maximum concurrent pipelines limit reached: ${this.config.maxConcurrentPipelines}`);
    }

    const pipelineId = this.generatePipelineId();
    const mergedConfig = { ...this.config.defaultPipelineConfig, ...config };
    
    const managedPipeline: ManagedPipeline = {
      id: pipelineId,
      name,
      pipeline: new MemoryPipeline(mergedConfig),
      config: mergedConfig,
      status: options.autoStart !== false ? 'active' : 'paused',
      createdAt: new Date(),
      lastUsed: new Date(),
      executionCount: 0
    };

    this.pipelines.set(pipelineId, managedPipeline);
    this.systemMetrics.totalPipelines++;
    
    if (managedPipeline.status === 'active') {
      this.systemMetrics.activePipelines++;
    }

    console.log(`✅ Created pipeline: ${name} (${pipelineId})`);
    
    return pipelineId;
  }

  /**
   * Create pipeline from template
   */
  createPipelineFromTemplate(
    templateName: string,
    customName: string,
    configOverrides: Partial<PipelineConfig> = {}
  ): string {
    const template = this.PIPELINE_TEMPLATES.find(t => t.name === templateName);
    if (!template) {
      throw new Error(`Pipeline template not found: ${templateName}`);
    }

    const config = { ...template.config, ...configOverrides };
    return this.createPipeline(customName, config);
  }

  /**
   * Get pipeline templates
   */
  getPipelineTemplates(): PipelineTemplate[] {
    return [...this.PIPELINE_TEMPLATES];
  }

  /**
   * Get managed pipeline
   */
  getPipeline(pipelineId: string): ManagedPipeline | null {
    return this.pipelines.get(pipelineId) || null;
  }

  /**
   * List all pipelines
   */
  listPipelines(): ManagedPipeline[] {
    return Array.from(this.pipelines.values());
  }

  /**
   * Start pipeline
   */
  startPipeline(pipelineId: string): boolean {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      return false;
    }

    if (managedPipeline.status !== 'active') {
      managedPipeline.status = 'active';
      this.systemMetrics.activePipelines++;
      console.log(`▶️ Started pipeline: ${managedPipeline.name}`);
    }

    return true;
  }

  /**
   * Pause pipeline
   */
  pausePipeline(pipelineId: string): boolean {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      return false;
    }

    if (managedPipeline.status === 'active') {
      managedPipeline.status = 'paused';
      this.systemMetrics.activePipelines--;
      console.log(`⏸️ Paused pipeline: ${managedPipeline.name}`);
    }

    return true;
  }

  /**
   * Stop and remove pipeline
   */
  removePipeline(pipelineId: string): boolean {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      return false;
    }

    if (managedPipeline.status === 'active') {
      this.systemMetrics.activePipelines--;
    }

    this.pipelines.delete(pipelineId);
    this.systemMetrics.totalPipelines--;
    
    console.log(`🗑️ Removed pipeline: ${managedPipeline.name}`);
    
    return true;
  }

  // ==================== MEMORY PROCESSING ====================

  /**
   * Process memory using specified pipeline
   */
  async processMemory(
    pipelineId: string,
    memory: Memory,
    userId: string,
    options?: any
  ): Promise<PipelineExecution> {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }

    if (managedPipeline.status !== 'active') {
      throw new Error(`Pipeline is not active: ${managedPipeline.name}`);
    }

    // Update pipeline usage
    managedPipeline.lastUsed = new Date();
    managedPipeline.executionCount++;
    this.systemMetrics.totalExecutions++;
    this.systemMetrics.activeExecutions++;

    try {
      const execution = await managedPipeline.pipeline.processMemory(memory, userId, options);
      
      // Update metrics
      this.systemMetrics.activeExecutions--;
      this.updatePerformanceMetrics(managedPipeline);
      
      return execution;

    } catch (error) {
      this.systemMetrics.activeExecutions--;
      throw error;
    }
  }

  /**
   * Process memories in batch using specified pipeline
   */
  async processMemoriesBatch(
    pipelineId: string,
    memories: Memory[],
    userId: string,
    options?: any
  ): Promise<PipelineExecution[]> {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }

    if (managedPipeline.status !== 'active') {
      throw new Error(`Pipeline is not active: ${managedPipeline.name}`);
    }

    // Update pipeline usage
    managedPipeline.lastUsed = new Date();
    managedPipeline.executionCount += memories.length;
    this.systemMetrics.totalExecutions += memories.length;
    this.systemMetrics.activeExecutions += memories.length;

    try {
      const executions = await managedPipeline.pipeline.processMemoriesBatch(memories, userId, options);
      
      // Update metrics
      this.systemMetrics.activeExecutions -= memories.length;
      this.updatePerformanceMetrics(managedPipeline);
      
      return executions;

    } catch (error) {
      this.systemMetrics.activeExecutions -= memories.length;
      throw error;
    }
  }

  // ==================== SCHEDULING ====================

  /**
   * Schedule memory processing
   */
  scheduleMemoryProcessing(
    pipelineId: string,
    userId: string,
    memories: Memory[],
    scheduledAt: Date,
    priority: 'low' | 'normal' | 'high' = 'normal'
  ): string {
    if (!this.config.enableScheduling) {
      throw new Error('Scheduling is not enabled');
    }

    const scheduleId = this.generateScheduleId();
    const schedule: PipelineSchedule = {
      id: scheduleId,
      pipelineId,
      userId,
      memories,
      scheduledAt,
      priority,
      status: 'scheduled'
    };

    this.schedules.set(scheduleId, schedule);
    
    // Set timeout for execution
    const delay = scheduledAt.getTime() - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        this.executeScheduledProcessing(scheduleId);
      }, delay);
    } else {
      // Execute immediately if time has passed
      setImmediate(() => this.executeScheduledProcessing(scheduleId));
    }

    console.log(`📅 Scheduled processing for ${memories.length} memories at ${scheduledAt.toISOString()}`);
    
    return scheduleId;
  }

  /**
   * Get scheduled processing jobs
   */
  getScheduledJobs(): PipelineSchedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Cancel scheduled job
   */
  cancelScheduledJob(scheduleId: string): boolean {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || schedule.status !== 'scheduled') {
      return false;
    }

    schedule.status = 'failed';
    console.log(`❌ Cancelled scheduled job: ${scheduleId}`);
    
    return true;
  }

  // ==================== MONITORING & HEALTH ====================

  /**
   * Get system metrics
   */
  getSystemMetrics(): SystemMetrics {
    this.updateSystemMetrics();
    return { ...this.systemMetrics };
  }

  /**
   * Get pipeline health status
   */
  getPipelineHealth(pipelineId: string): any {
    const managedPipeline = this.pipelines.get(pipelineId);
    if (!managedPipeline) {
      return null;
    }

    return managedPipeline.pipeline.getPipelineHealth();
  }

  /**
   * Get all pipeline executions
   */
  getAllExecutions(): { pipelineId: string; executions: PipelineExecution[] }[] {
    const results: { pipelineId: string; executions: PipelineExecution[] }[] = [];
    
    for (const [pipelineId, managedPipeline] of this.pipelines.entries()) {
      const executions = managedPipeline.pipeline.getUserExecutions(''); // Get all executions
      results.push({ pipelineId, executions });
    }

    return results;
  }

  /**
   * Cleanup completed executions across all pipelines
   */
  cleanupCompletedExecutions(): number {
    let totalCleared = 0;
    
    for (const managedPipeline of this.pipelines.values()) {
      const cleared = managedPipeline.pipeline.clearCompletedExecutions();
      totalCleared += cleared;
    }

    console.log(`🧹 Cleaned up ${totalCleared} completed executions across all pipelines`);
    
    return totalCleared;
  }

  /**
   * Get system health summary
   */
  getSystemHealth(): {
    overallStatus: 'healthy' | 'degraded' | 'critical';
    pipelineHealth: Array<{ pipelineId: string; status: string; issues: string[] }>;
    systemLoad: number;
    recommendations: string[];
  } {
    const pipelineHealth = [];
    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    const recommendations: string[] = [];

    // Check each pipeline health
    for (const [pipelineId, managedPipeline] of this.pipelines.entries()) {
      const health = managedPipeline.pipeline.getPipelineHealth();
      pipelineHealth.push({
        pipelineId,
        status: health.status,
        issues: health.issues
      });

      if (health.status === 'critical') {
        overallStatus = 'critical';
      } else if (health.status === 'degraded' && overallStatus !== 'critical') {
        overallStatus = 'degraded';
      }
    }

    // System-level recommendations
    if (this.systemMetrics.activePipelines > 8) {
      recommendations.push('High number of active pipelines - consider consolidation');
    }
    
    if (this.systemMetrics.systemLoad > 0.8) {
      recommendations.push('High system load - consider reducing concurrent operations');
    }

    return {
      overallStatus,
      pipelineHealth,
      systemLoad: this.systemMetrics.systemLoad,
      recommendations
    };
  }

  /**
   * Shutdown pipeline manager
   */
  shutdown(): void {
    console.log('🛑 Shutting down PipelineManager...');

    // Clear health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Pause all pipelines
    for (const [pipelineId] of this.pipelines.entries()) {
      this.pausePipeline(pipelineId);
    }

    console.log('✅ PipelineManager shutdown complete');
  }

  // ==================== PRIVATE METHODS ====================

  private async executeScheduledProcessing(scheduleId: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || schedule.status !== 'scheduled') {
      return;
    }

    schedule.status = 'running';
    
    try {
      console.log(`🚀 Executing scheduled processing: ${scheduleId}`);
      
      const executions = await this.processMemoriesBatch(
        schedule.pipelineId,
        schedule.memories,
        schedule.userId
      );

      schedule.status = 'completed';
      schedule.result = executions;
      
      console.log(`✅ Scheduled processing completed: ${scheduleId}`);

    } catch (error) {
      schedule.status = 'failed';
      console.error(`❌ Scheduled processing failed: ${scheduleId}`, error);
    }
  }

  private startHealthChecks(): void {
    if (!this.config.enableHealthChecks) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);

    console.log(`💚 Started health checks (interval: ${this.config.healthCheckIntervalMs}ms)`);
  }

  private performHealthCheck(): void {
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

    // Check system load
    const activeExecutions = this.systemMetrics.activeExecutions;
    const maxConcurrent = this.config.maxConcurrentPipelines * 10; // Estimated max
    
    this.systemMetrics.systemLoad = activeExecutions / maxConcurrent;

    if (this.systemMetrics.systemLoad > 0.9) {
      issues.push('System overloaded');
      status = 'critical';
    } else if (this.systemMetrics.systemLoad > 0.7) {
      issues.push('High system load');
      if (status === 'healthy') status = 'degraded';
    }

    // Check pipeline health
    for (const managedPipeline of this.pipelines.values()) {
      const pipelineHealth = managedPipeline.pipeline.getPipelineHealth();
      if (pipelineHealth.status === 'critical') {
        issues.push(`Pipeline ${managedPipeline.name} is critical`);
        status = 'critical';
      } else if (pipelineHealth.status === 'degraded') {
        issues.push(`Pipeline ${managedPipeline.name} is degraded`);
        if (status === 'healthy') status = 'degraded';
      }
    }

    this.systemMetrics.health = {
      status,
      issues,
      lastCheck: new Date()
    };

    if (issues.length > 0) {
      console.warn(`⚠️ Health check issues detected:`, issues);
    }
  }

  private updateSystemMetrics(): void {
    // Update basic counts
    this.systemMetrics.totalPipelines = this.pipelines.size;
    this.systemMetrics.activePipelines = Array.from(this.pipelines.values())
      .filter(p => p.status === 'active').length;

    // Calculate performance metrics
    let totalExecutions = 0;
    let totalProcessingTime = 0;
    let successfulExecutions = 0;

    for (const managedPipeline of this.pipelines.values()) {
      const metrics = managedPipeline.pipeline.getPipelineMetrics();
      totalExecutions += metrics.totalExecutions;
      successfulExecutions += metrics.successfulExecutions;
      totalProcessingTime += metrics.averageProcessingTime * metrics.totalExecutions;
    }

    this.systemMetrics.performance = {
      averageExecutionTime: totalExecutions > 0 ? totalProcessingTime / totalExecutions : 0,
      throughput: Array.from(this.pipelines.values()).reduce((sum, p) => 
        sum + p.pipeline.getPipelineMetrics().throughput.memoriesPerHour, 0
      ),
      successRate: totalExecutions > 0 ? successfulExecutions / totalExecutions : 1
    };

    // Update memory usage (simplified)
    this.systemMetrics.memoryUsage = {
      used: this.systemMetrics.activeExecutions * 10, // Estimated MB per execution
      total: 1024, // Estimated total available MB
      percentage: (this.systemMetrics.activeExecutions * 10) / 1024
    };
  }

  private updatePerformanceMetrics(managedPipeline: ManagedPipeline): void {
    // Update performance tracking for the pipeline
    const metrics = managedPipeline.pipeline.getPipelineMetrics();
    
    // Could implement more sophisticated performance tracking here
    // For now, metrics are tracked within each pipeline
  }

  private generatePipelineId(): string {
    return `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateScheduleId(): string {
    return `schedule_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export default PipelineManager;