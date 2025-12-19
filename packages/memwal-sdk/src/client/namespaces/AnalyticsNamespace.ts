/**
 * Analytics Namespace - Memory Analytics & Insights
 *
 * Pure delegation to MemoryAnalyticsService for comprehensive analytics.
 * Provides insights, trends, clustering, and recommendations.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type {
  MemoryAnalytics,
  UsagePattern,
  SimilarityCluster,
  MemoryInsights
} from '../../retrieval/MemoryAnalyticsService';

/**
 * Analytics options
 */
export interface AnalyticsOptions {
  periodStart?: Date;
  periodEnd?: Date;
  includeForecasting?: boolean;
  includeClustering?: boolean;
  includeInsights?: boolean;
}

/**
 * Category distribution
 */
export interface CategoryDistribution {
  category: string;
  count: number;
  percentage: number;
}

/**
 * Trend data
 */
export interface TrendData {
  direction: 'up' | 'down' | 'stable' | 'volatile';
  strength: number;
  forecast?: Array<{ date: Date; predicted: number; confidence: number }>;
}

/**
 * Analytics Namespace
 *
 * Handles memory analytics, insights, and visualization data
 */
export class AnalyticsNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Generate comprehensive analytics report
   *
   * Delegates to: MemoryAnalyticsService.generateMemoryAnalytics()
   *
   * @param options - Analytics options
   * @returns Complete analytics report
   */
  async generate(options?: AnalyticsOptions): Promise<MemoryAnalytics> {
    if (!this.services.analytics) {
      throw new Error('Analytics service not configured.');
    }

    // Get user's memories first
    const memoriesResult = await this.services.viewService?.getUserMemories(
      this.services.config.userAddress
    );

    const memories = memoriesResult?.data || [];

    // Convert to UnifiedMemoryResult format
    const unifiedMemories = memories.map((m: any) => ({
      id: m.id,
      category: m.category,
      created: new Date(m.createdAt || Date.now()),
      metadata: {
        size: 0,
        importance: m.importance || 5,
        contentType: 'text',
        tags: m.tags || []
      },
      analytics: {
        viewCount: 0
      }
    }));

    return await this.services.analytics.generateMemoryAnalytics(
      this.services.config.userAddress,
      unifiedMemories as any,
      options
    );
  }

  /**
   * Get category distribution
   *
   * Delegates to: MemoryAnalyticsService.generateMemoryAnalytics() → topCategories
   *
   * @returns Category distribution data
   */
  async categories(): Promise<CategoryDistribution[]> {
    const analytics = await this.generate({ includeInsights: false, includeClustering: false });
    return analytics.topCategories;
  }

  /**
   * Get temporal trends
   *
   * Delegates to: MemoryAnalyticsService.generateMemoryAnalytics() → temporalTrends
   *
   * @returns Trend analysis data
   */
  async trends(): Promise<{
    creation: TrendData;
    access: TrendData;
    size: TrendData;
  }> {
    const analytics = await this.generate({ includeForecasting: true });

    return {
      creation: {
        direction: analytics.temporalTrends.creationTrend.direction,
        strength: analytics.temporalTrends.creationTrend.strength,
        forecast: analytics.temporalTrends.creationTrend.forecast
      },
      access: {
        direction: analytics.temporalTrends.accessTrend.direction,
        strength: analytics.temporalTrends.accessTrend.strength,
        forecast: analytics.temporalTrends.accessTrend.forecast
      },
      size: {
        direction: analytics.temporalTrends.sizeTrend.direction,
        strength: analytics.temporalTrends.sizeTrend.strength,
        forecast: analytics.temporalTrends.sizeTrend.forecast
      }
    };
  }

  /**
   * Get importance distribution
   *
   * Analyzes how memories are distributed by importance level
   *
   * @returns Importance analysis
   */
  async importance(): Promise<{
    average: number;
    distribution: Record<number, number>;
    highImportance: number;
    lowImportance: number;
  }> {
    const analytics = await this.generate({ includeInsights: false });

    // Calculate distribution from memories
    const memoriesResult = await this.services.viewService?.getUserMemories(
      this.services.config.userAddress
    );

    const memories = memoriesResult?.data || [];

    const distribution: Record<number, number> = {};
    let highCount = 0;
    let lowCount = 0;

    memories.forEach((m: any) => {
      const imp = m.importance || 5;
      distribution[imp] = (distribution[imp] || 0) + 1;

      if (imp >= 8) highCount++;
      if (imp <= 3) lowCount++;
    });

    return {
      average: analytics.averageImportance,
      distribution,
      highImportance: highCount,
      lowImportance: lowCount
    };
  }

  /**
   * Get temporal patterns
   *
   * Delegates to: MemoryAnalyticsService.analyzeUsagePatterns()
   *
   * @returns Usage patterns by time
   */
  async temporal(): Promise<UsagePattern[]> {
    const analytics = await this.generate({ includeInsights: false });
    return analytics.usagePatterns;
  }

  /**
   * Get AI-generated insights
   *
   * Delegates to: MemoryAnalyticsService.generateKnowledgeInsights()
   *
   * @returns Knowledge insights and recommendations
   */
  async insights(): Promise<MemoryInsights> {
    const analytics = await this.generate({ includeInsights: true });
    return analytics.knowledgeInsights;
  }

  /**
   * Detect anomalies in memory patterns
   *
   * Finds unusual patterns or outliers
   *
   * @returns Array of detected anomalies
   */
  async anomalies(): Promise<Array<{
    date: Date;
    type: 'spike' | 'drop' | 'outlier';
    severity: number;
    description: string;
  }>> {
    const analytics = await this.generate();

    // Extract anomalies from usage patterns
    const anomalies: Array<{
      date: Date;
      type: 'spike' | 'drop' | 'outlier';
      severity: number;
      description: string;
    }> = [];

    analytics.usagePatterns.forEach(pattern => {
      pattern.anomalies.forEach(anomaly => {
        anomalies.push({
          date: anomaly.date,
          type: anomaly.type,
          severity: anomaly.severity,
          description: anomaly.possibleCauses?.join(', ') || 'Unknown cause'
        });
      });
    });

    return anomalies;
  }

  /**
   * Analyze correlations between categories/topics
   *
   * Finds relationships between different memory types
   *
   * @returns Correlation data
   */
  async correlations(): Promise<Array<{
    concept1: string;
    concept2: string;
    strength: number;
    memoryCount: number;
  }>> {
    const analytics = await this.generate({ includeInsights: true });

    // Extract from conceptual connections
    return analytics.knowledgeInsights.conceptualConnections.map(conn => ({
      concept1: conn.concept1,
      concept2: conn.concept2,
      strength: conn.connectionStrength,
      memoryCount: conn.bridgeMemories.length
    }));
  }

  /**
   * Analyze a single memory
   *
   * Get detailed analytics for one memory
   *
   * @param memoryId - Memory ID to analyze
   * @returns Memory-specific analytics
   */
  async analyze(memoryId: string): Promise<{
    memoryId: string;
    importance: number;
    category: string;
    relatedCount: number;
    clusterInfo?: {
      clusterId: string;
      similarity: number;
    };
  }> {
    // Get memory details
    const memory = await this.services.storage.retrieveMemoryPackage(memoryId);

    // Decode content if it's Uint8Array
    const content = typeof memory.content === 'string'
      ? memory.content
      : new TextDecoder().decode(memory.content);

    // Related memories search requires vector service
    // For now return basic analysis without related count
    return {
      memoryId,
      importance: memory.metadata.importance || 5,
      category: memory.metadata.category,
      relatedCount: 0, // Would require vector search
      clusterInfo: undefined // Would require full clustering analysis
    };
  }

  /**
   * Get visualization-ready data
   *
   * Formats analytics for charts and graphs
   *
   * @returns Chart-ready data
   */
  async visualizationData(): Promise<{
    categoryChart: Array<{ name: string; value: number }>;
    importanceChart: Array<{ level: number; count: number }>;
    timelineChart: Array<{ date: string; count: number }>;
    clusterChart: Array<{ id: string; size: number; coherence: number }>;
  }> {
    const analytics = await this.generate({ includeClustering: true });

    // Category chart data
    const categoryChart = analytics.topCategories.map(c => ({
      name: c.category,
      value: c.count
    }));

    // Importance chart data
    const importanceData = await this.importance();
    const importanceChart = Object.entries(importanceData.distribution).map(([level, count]) => ({
      level: parseInt(level),
      count
    }));

    // Timeline chart data - aggregate memories by date
    const timelineChart: Array<{ date: string; count: number }> = [];
    try {
      const memoriesResult = await this.services.viewService?.getUserMemories(
        this.services.config.userAddress,
        { limit: 1000 }
      );
      const memories = memoriesResult?.data || [];

      // Group memories by date (YYYY-MM-DD)
      const dateCountMap = new Map<string, number>();
      memories.forEach((m: any) => {
        const timestamp = m.createdAt || m.updatedAt || Date.now();
        const dateStr = new Date(timestamp).toISOString().split('T')[0];
        dateCountMap.set(dateStr, (dateCountMap.get(dateStr) || 0) + 1);
      });

      // Sort by date and convert to array
      const sortedDates = Array.from(dateCountMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]));

      sortedDates.forEach(([date, count]) => {
        timelineChart.push({ date, count });
      });
    } catch (error) {
      console.warn('Failed to generate timeline chart data:', error);
    }

    // Cluster chart data
    const clusterChart = analytics.similarityClusters.map(c => ({
      id: c.id,
      size: c.size,
      coherence: c.coherence
    }));

    return {
      categoryChart,
      importanceChart,
      timelineChart,
      clusterChart
    };
  }
}
