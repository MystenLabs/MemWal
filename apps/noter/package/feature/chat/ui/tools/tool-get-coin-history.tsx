/**
 * GetCoinHistory Tool UI
 *
 * Displays cryptocurrency historical price chart
 */

"use client";

import type { GetCoinHistoryOutput } from "@/shared/lib/ai/tools";
import { Button } from "@/shared/components/ui/button";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Calendar, ChevronDown, ChevronUp, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";

type ToolGetCoinHistoryProps = {
  output: GetCoinHistoryOutput;
};

function formatPrice(price: number): string {
  if (price >= 1000) {
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else if (price >= 1) {
    return `$${price.toFixed(4)}`;
  } else {
    return `$${price.toFixed(6)}`;
  }
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function calculatePriceChange(data: GetCoinHistoryOutput["data"]): { change: number; percent: number } {
  if (data.length < 2) return { change: 0, percent: 0 };

  const firstPrice = data[0].price;
  const lastPrice = data[data.length - 1].price;
  const change = lastPrice - firstPrice;
  const percent = (change / firstPrice) * 100;

  return { change, percent };
}

export function ToolGetCoinHistory({ output }: ToolGetCoinHistoryProps) {
  const { symbol, name, data } = output;
  const [expanded, setExpanded] = useState(false);

  if (data.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="text-sm text-muted-foreground text-center">
          No historical data available for {symbol}
        </div>
      </div>
    );
  }

  const currentPrice = data[data.length - 1].price;
  const { change, percent } = calculatePriceChange(data);
  const isPositive = change >= 0;

  // Format data for chart
  const chartData = data.map((point) => ({
    timestamp: point.timestamp,
    price: point.price,
    formattedDate: formatDate(point.timestamp),
    formattedDateTime: formatDateTime(point.timestamp),
  }));

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-0 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        <span className="text-xs">{expanded ? "Hide" : "Show"} details</span>
      </Button>

      {expanded && (
        <>
          <div className="flex items-start justify-between pt-2">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{name}</h3>
                <span className="text-sm text-muted-foreground">{symbol}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold">{formatPrice(currentPrice)}</span>
                <div
                  className={`flex items-center gap-1 text-sm font-medium ${isPositive ? "text-green-600" : "text-red-600"}`}
                >
                  {isPositive ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                  <span>{isPositive ? "+" : ""}{formatPrice(change)}</span>
                  <span>({isPositive ? "+" : ""}{percent.toFixed(2)}%)</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="size-3.5" />
              <span>{data.length} {data.length === 1 ? "day" : "days"}</span>
            </div>
          </div>
        </>
      )}

      {/* Chart */}
      <div className="w-full h-64">
        <ResponsiveContainer width="100%" height="100%" className={'-translate-x-12'}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="formattedDate"
              tick={{ fontSize: 12 }}
              className="text-muted-foreground"
            />
            <YAxis
              tick={{ fontSize: 12 }}
              className="text-muted-foreground"
              tickFormatter={(value) => {
                if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`;
                return `$${value.toFixed(0)}`;
              }}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null;

                const data = payload[0].payload;

                return (
                  <div className="rounded-lg border bg-background p-3 shadow-lg">
                    <div className="text-xs text-muted-foreground mb-1">
                      {data.formattedDateTime}
                    </div>
                    <div className="font-semibold text-sm">
                      {formatPrice(data.price)}
                    </div>
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="price"
              stroke={isPositive ? "#10b981" : "#ef4444"}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {expanded && (
        <div className="grid grid-cols-3 gap-3 border-t pt-2">
          <div>
            <div className="text-xs text-muted-foreground">High</div>
            <div className="text-sm font-medium">
              {formatPrice(Math.max(...data.map((d) => d.price)))}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Low</div>
            <div className="text-sm font-medium">
              {formatPrice(Math.min(...data.map((d) => d.price)))}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Avg Volume</div>
            <div className="text-sm font-medium">
              ${(data.reduce((sum, d) => sum + d.volume24h, 0) / data.length / 1_000_000_000).toFixed(2)}B
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
