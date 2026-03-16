import { tool, jsonSchema } from "ai";
import type { User } from "@/shared/db/type";
import { getSuiClient } from "@/feature/auth/lib/zklogin-client";
import { recallMemories } from "@/feature/note/lib/pdw-client";

type GetTimeInput = {
  confirm: boolean;
  timezone?: string;
};

type GetTimeOutput = {
  timezone: string;
  formatted: string;
  iso: string;
  timestamp: number;
};

type GetUserInfoInput = {
  confirm: boolean;
};

export type GetUserInfoOutput = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  suiAddress: string;
  authMethod: "zklogin" | "wallet";
  provider: string | null;
  walletType: string | null;
  memberSince: string;
  lastSeenAt: string | null;
};

type GetBalancesInput = {
  confirm: boolean;
};

export type Balance = {
  coinType: string;
  coinObjectCount: number;
  totalBalance: string;
  lockedBalance: Record<string, string>;
};

export type GetBalancesOutput = {
  address: string;
  balances: Balance[];
  totalCoins: number;
};

type GetTransactionsInput = {
  confirm: boolean;
  limit?: number;
};

export type Transaction = {
  digest: string;
  timestampMs: string;
  checkpoint: string;
  effects: {
    status: { status: string };
  };
};

export type GetTransactionsOutput = {
  address: string;
  transactions: Transaction[];
  hasMore: boolean;
};

type GetOwnedObjectsInput = {
  confirm: boolean;
  limit?: number;
};

export type OwnedObject = {
  objectId: string;
  version: string;
  digest: string;
  type: string | null;
  display: {
    name?: string;
    description?: string;
    image_url?: string;
  } | null;
};

export type GetOwnedObjectsOutput = {
  address: string;
  objects: OwnedObject[];
  totalCount: number;
  hasMore: boolean;
};

type GetStakesInput = {
  confirm: boolean;
};

export type StakeObject = {
  stakedSuiId: string;
  stakeRequestEpoch: string;
  stakeActiveEpoch: string;
  principal: string;
  status: string;
  estimatedReward?: string;
};

export type GetStakesOutput = {
  address: string;
  stakes: StakeObject[];
  totalStaked: string;
  totalRewards: string;
};

type GetCoinMetadataInput = {
  confirm: boolean;
  coinType: string;
};

export type CoinMetadataOutput = {
  coinType: string;
  name: string;
  symbol: string;
  description: string;
  decimals: number;
  iconUrl: string | null;
};

type GetCryptoPriceInput = {
  confirm: boolean;
  symbols: string;
};

export type CryptoPrice = {
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  percentChange1h: number;
  percentChange24h: number;
  percentChange7d: number;
};

export type GetCryptoPriceOutput = {
  coins: CryptoPrice[];
  timestamp: string;
};

type GetTrendingCoinsInput = {
  confirm: boolean;
  limit?: number;
};

export type TrendingCoin = {
  symbol: string;
  name: string;
  price: number;
  percentChange24h: number;
  marketCap: number;
  rank: number;
};

export type GetTrendingCoinsOutput = {
  gainers: TrendingCoin[];
  losers: TrendingCoin[];
};

type SearchCoinsInput = {
  confirm: boolean;
  query: string;
};

export type CoinSearchResult = {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  rank: number;
};

export type SearchCoinsOutput = {
  results: CoinSearchResult[];
  totalCount: number;
};

type GetCoinHistoryInput = {
  confirm: boolean;
  symbol: string;
  days?: number;
};

export type HistoricalDataPoint = {
  timestamp: string;
  price: number;
  volume24h: number;
  marketCap: number;
};

export type GetCoinHistoryOutput = {
  symbol: string;
  name: string;
  data: HistoricalDataPoint[];
};

type GetGlobalMarketStatsInput = {
  confirm: boolean;
};

export type GlobalMarketStats = {
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  ethDominance: number;
  activeCryptocurrencies: number;
  markets: number;
  marketCapChangePercentage24h: number;
};

type GetFearGreedIndexInput = {
  confirm: boolean;
};

export type FearGreedIndex = {
  value: number;
  classification: string;
  timestamp: string;
};

type GetTopCoinsInput = {
  confirm: boolean;
  limit?: number;
};

export type TopCoin = {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  price: number;
  marketCap: number;
  volume24h: number;
  percentChange24h: number;
};

export type GetTopCoinsOutput = {
  coins: TopCoin[];
};

type GetCoinCategoriesInput = {
  confirm: boolean;
};

export type CoinCategory = {
  id: string;
  name: string;
  marketCap: number;
  marketCapChange24h: number;
  volume24h: number;
  topCoins: string[];
};

export type GetCoinCategoriesOutput = {
  categories: CoinCategory[];
};

type GetCoinsByCategoryInput = {
  confirm: boolean;
  categoryId: string;
};

export type CoinInCategory = {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  price: number;
};

export type GetCoinsByCategoryOutput = {
  category: string;
  coins: CoinInCategory[];
};

type GetCoinDetailsInput = {
  confirm: boolean;
  coinId: string;
};

export type CoinDetails = {
  id: string;
  symbol: string;
  name: string;
  description: string;
  homepage: string | null;
  whitepaper: string | null;
  blockchain: string | null;
  genesisDate: string | null;
  marketCapRank: number;
};

type ShowDiagramInput = {
  confirm: boolean;
  diagramType: 'zklogin' | 'nautilus' | 'seal' | 'walrus';
};

export type ShowDiagramOutput = {
  diagramType: string;
  title: string;
  svgPath: string;
  docsUrl: string;
};

type SearchUserMemoriesInput = {
  confirm: boolean;
  query: string;
  limit?: number;
};

export type UserMemory = {
  id: string;
  text: string;
  category: string;
  importance: number;
  similarity: number;
  createdAt: string;
  blobId?: string;
};

export type SearchUserMemoriesOutput = {
  query: string;
  memories: UserMemory[];
  count: number;
  error?: string;
};

export const createTools = (user: User | null) => ({
  getTime: tool({
    description:
      'Get current date and time. Usage: getTime({confirm: true}) or getTime({confirm: true, timezone: "Asia/Tokyo"})',
    inputSchema: jsonSchema<GetTimeInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get time",
        },
        timezone: {
          type: "string" as const,
          description:
            'Timezone (e.g., "America/New_York", "Asia/Tokyo"). Defaults to UTC.',
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async ({ timezone = "UTC" }): Promise<GetTimeOutput> => {
      const now = new Date();

      const formatted = now.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });

      return {
        timezone,
        formatted,
        iso: now.toISOString(),
        timestamp: now.getTime(),
      };
    },
  }),

  getUserInfo: tool({
    description:
      'Get the current authenticated user information including name, email, Sui address, authentication method (zkLogin or wallet), and account details. Usage: getUserInfo({confirm: true})',
    inputSchema: jsonSchema<GetUserInfoInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get user info",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<GetUserInfoOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const memberSince = new Date(user.createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const lastSeenAt = user.lastSeenAt
        ? new Date(user.lastSeenAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
        : null;

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        suiAddress: user.suiAddress,
        authMethod: user.authMethod,
        provider: user.provider,
        walletType: user.walletType,
        memberSince,
        lastSeenAt,
      };
    },
  }),

  getBalances: tool({
    description:
      'Get all token balances for the authenticated user on Sui blockchain. Shows SUI and all other tokens owned. Usage: getBalances({confirm: true})',
    inputSchema: jsonSchema<GetBalancesInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get balances",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<GetBalancesOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const client = getSuiClient();
      const balances = await client.getAllBalances({ owner: user.suiAddress });

      return {
        address: user.suiAddress,
        balances: balances.map((b: any) => ({
          coinType: b.coinType,
          coinObjectCount: b.coinObjectCount,
          totalBalance: b.totalBalance,
          lockedBalance: b.lockedBalance,
        })),
        totalCoins: balances.length,
      };
    },
  }),

  getTransactions: tool({
    description:
      'Get recent transactions for the authenticated user on Sui blockchain. Shows transaction history including status and timestamp. Usage: getTransactions({confirm: true, limit: 10})',
    inputSchema: jsonSchema<GetTransactionsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get transactions",
        },
        limit: {
          type: "number" as const,
          description: "Number of transactions to fetch (default: 10, max: 50)",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async ({ limit = 10 }): Promise<GetTransactionsOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const client = getSuiClient();
      const maxLimit = Math.min(limit, 50);

      const result = await client.queryTransactionBlocks({
        filter: { FromAddress: user.suiAddress },
        options: {
          showEffects: true,
          showInput: false,
          showEvents: false,
          showObjectChanges: false,
          showBalanceChanges: false,
        },
        limit: maxLimit,
        order: 'descending',
      });

      return {
        address: user.suiAddress,
        transactions: result.data.map((tx: any) => ({
          digest: tx.digest,
          timestampMs: tx.timestampMs || '0',
          checkpoint: tx.checkpoint || '0',
          effects: {
            status: {
              status: tx.effects?.status?.status || 'unknown',
            },
          },
        })),
        hasMore: result.hasNextPage,
      };
    },
  }),

  getOwnedObjects: tool({
    description:
      'Get all objects owned by the user (NFTs, game items, collectibles, etc.). Shows object type, display metadata, and images. Usage: getOwnedObjects({confirm: true, limit: 20})',
    inputSchema: jsonSchema<GetOwnedObjectsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get owned objects",
        },
        limit: {
          type: "number" as const,
          description: "Number of objects to fetch (default: 20, max: 50)",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async ({ limit = 20 }): Promise<GetOwnedObjectsOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const client = getSuiClient();
      const maxLimit = Math.min(limit, 50);

      const result = await client.getOwnedObjects({
        owner: user.suiAddress,
        options: {
          showType: true,
          showContent: true,
          showDisplay: true,
        },
        limit: maxLimit,
      });

      return {
        address: user.suiAddress,
        objects: result.data.map((obj: any) => ({
          objectId: obj.data?.objectId || '',
          version: obj.data?.version || '0',
          digest: obj.data?.digest || '',
          type: obj.data?.type || null,
          display: obj.data?.display?.data || null,
        })),
        totalCount: result.data.length,
        hasMore: result.hasNextPage,
      };
    },
  }),

  getStakes: tool({
    description:
      'Get all staking positions for the user. Shows staked SUI amount, validator, rewards, and status. Usage: getStakes({confirm: true})',
    inputSchema: jsonSchema<GetStakesInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get staking positions",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<GetStakesOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const client = getSuiClient();
      const stakes = await client.getStakes({ owner: user.suiAddress });

      let totalStaked = BigInt(0);
      let totalRewards = BigInt(0);

      const stakeObjects = stakes.map((stake: any) => {
        const stakeObj = stake.stakes[0];
        const principal = BigInt(stakeObj?.principal || 0);
        const estimatedReward = (stakeObj && 'estimatedReward' in stakeObj && stakeObj.estimatedReward)
          ? BigInt(stakeObj.estimatedReward)
          : BigInt(0);

        totalStaked += principal;
        totalRewards += estimatedReward;

        return {
          stakedSuiId: stakeObj?.stakedSuiId || '',
          stakeRequestEpoch: stakeObj?.stakeRequestEpoch || '0',
          stakeActiveEpoch: stakeObj?.stakeActiveEpoch || '0',
          principal: principal.toString(),
          status: stakeObj?.status || 'Unknown',
          estimatedReward: estimatedReward.toString(),
        };
      });

      return {
        address: user.suiAddress,
        stakes: stakeObjects,
        totalStaked: totalStaked.toString(),
        totalRewards: totalRewards.toString(),
      };
    },
  }),

  getCoinMetadata: tool({
    description:
      'Get detailed metadata for any coin type (name, symbol, decimals, icon). Useful for displaying coin information. Usage: getCoinMetadata({confirm: true, coinType: "0x2::sui::SUI"})',
    inputSchema: jsonSchema<GetCoinMetadataInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get coin metadata",
        },
        coinType: {
          type: "string" as const,
          description: "The coin type to get metadata for (e.g., '0x2::sui::SUI')",
        },
      },
      required: ["confirm", "coinType"],
      additionalProperties: false,
    }),
    execute: async ({ coinType }): Promise<CoinMetadataOutput> => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const client = getSuiClient();
      const metadata = await client.getCoinMetadata({ coinType });

      if (!metadata) {
        throw new Error(`No metadata found for coin type: ${coinType}`);
      }

      return {
        coinType,
        name: metadata.name || 'Unknown',
        symbol: metadata.symbol || 'Unknown',
        description: metadata.description || '',
        decimals: metadata.decimals || 9,
        iconUrl: metadata.iconUrl || null,
      };
    },
  }),

  getCryptoPrice: tool({
    description:
      'Get current cryptocurrency prices, market cap, volume, and price changes. Supports multiple coins (comma-separated). Usage: getCryptoPrice({confirm: true, symbols: "BTC,ETH,SUI"})',
    inputSchema: jsonSchema<GetCryptoPriceInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get crypto prices",
        },
        symbols: {
          type: "string" as const,
          description: "Comma-separated cryptocurrency symbols (e.g., 'BTC,ETH,SUI')",
        },
      },
      required: ["confirm", "symbols"],
      additionalProperties: false,
    }),
    execute: async ({ symbols }): Promise<GetCryptoPriceOutput> => {
      const apiKey = process.env.COINMARKETCAP_API_KEY;
      if (!apiKey) {
        throw new Error('CoinMarketCap API key not configured');
      }

      const response = await fetch(
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbols}`,
        {
          headers: {
            'X-CMC_PRO_API_KEY': apiKey,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`CoinMarketCap API error: ${response.status}`);
      }

      const data = await response.json();

      const coins: CryptoPrice[] = Object.values(data.data).map((coin: any) => ({
        symbol: coin.symbol,
        name: coin.name,
        price: coin.quote.USD.price,
        marketCap: coin.quote.USD.market_cap,
        volume24h: coin.quote.USD.volume_24h,
        percentChange1h: coin.quote.USD.percent_change_1h,
        percentChange24h: coin.quote.USD.percent_change_24h,
        percentChange7d: coin.quote.USD.percent_change_7d,
      }));

      return {
        coins,
        timestamp: data.status.timestamp,
      };
    },
  }),

  getTrendingCoins: tool({
    description:
      'Get top gaining and losing cryptocurrencies in the last 24 hours. Shows the biggest movers in the market. Usage: getTrendingCoins({confirm: true, limit: 10})',
    inputSchema: jsonSchema<GetTrendingCoinsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get trending coins",
        },
        limit: {
          type: "number" as const,
          description: "Number of top gainers/losers to return (default: 10, max: 20)",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async ({ limit = 10 }): Promise<GetTrendingCoinsOutput> => {
      const apiKey = process.env.COINMARKETCAP_API_KEY;
      if (!apiKey) {
        throw new Error('CoinMarketCap API key not configured');
      }

      const maxLimit = Math.min(limit, 20);

      // Get top coins sorted by 24h change
      const response = await fetch(
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=100&sort=percent_change_24h&sort_dir=desc`,
        {
          headers: {
            'X-CMC_PRO_API_KEY': apiKey,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`CoinMarketCap API error: ${response.status}`);
      }

      const data = await response.json();

      const allCoins = data.data.map((coin: any) => ({
        symbol: coin.symbol,
        name: coin.name,
        price: coin.quote.USD.price,
        percentChange24h: coin.quote.USD.percent_change_24h,
        marketCap: coin.quote.USD.market_cap,
        rank: coin.cmc_rank,
      }));

      // Sort by percent change
      const sorted = [...allCoins].sort((a, b) => b.percentChange24h - a.percentChange24h);

      return {
        gainers: sorted.slice(0, maxLimit),
        losers: sorted.slice(-maxLimit).reverse(),
      };
    },
  }),

  searchCoins: tool({
    description:
      'Search for cryptocurrencies by name or symbol. Find coins to get their data. Usage: searchCoins({confirm: true, query: "bitcoin"})',
    inputSchema: jsonSchema<SearchCoinsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to search coins",
        },
        query: {
          type: "string" as const,
          description: "Search query (coin name or symbol)",
        },
      },
      required: ["confirm", "query"],
      additionalProperties: false,
    }),
    execute: async ({ query }): Promise<SearchCoinsOutput> => {
      const apiKey = process.env.COINMARKETCAP_API_KEY;
      if (!apiKey) {
        throw new Error('CoinMarketCap API key not configured');
      }

      const response = await fetch(
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?limit=5000`,
        {
          headers: {
            'X-CMC_PRO_API_KEY': apiKey,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`CoinMarketCap API error: ${response.status}`);
      }

      const data = await response.json();

      const queryLower = query.toLowerCase();
      const filtered = data.data
        .filter((coin: any) =>
          coin.name.toLowerCase().includes(queryLower) ||
          coin.symbol.toLowerCase().includes(queryLower)
        )
        .slice(0, 20)
        .map((coin: any) => ({
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          slug: coin.slug,
          rank: coin.rank,
        }));

      return {
        results: filtered,
        totalCount: filtered.length,
      };
    },
  }),

  getCoinHistory: tool({
    description:
      'Get historical price data for a cryptocurrency with chart visualization. Shows price, volume, and market cap over time. Usage: getCoinHistory({confirm: true, symbol: "BTC", days: 7})',
    inputSchema: jsonSchema<GetCoinHistoryInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get historical data",
        },
        symbol: {
          type: "string" as const,
          description: "Cryptocurrency symbol (e.g., 'BTC', 'ETH', 'SUI')",
        },
        days: {
          type: "number" as const,
          description: "Number of days of history to fetch (1, 7, 30, 90, 365)",
        },
      },
      required: ["confirm", "symbol"],
      additionalProperties: false,
    }),
    execute: async ({ symbol, days = 7 }): Promise<GetCoinHistoryOutput> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      // Add API key if available for better rate limits
      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      // Map common symbols to CoinGecko IDs
      const symbolToId: Record<string, string> = {
        'BTC': 'bitcoin',
        'ETH': 'ethereum',
        'SUI': 'sui',
        'SOL': 'solana',
        'BNB': 'binancecoin',
        'XRP': 'ripple',
        'ADA': 'cardano',
        'DOGE': 'dogecoin',
        'MATIC': 'matic-network',
        'DOT': 'polkadot',
        'AVAX': 'avalanche-2',
        'UNI': 'uniswap',
        'LINK': 'chainlink',
        'ATOM': 'cosmos',
        'APT': 'aptos',
      };

      const coinId = symbolToId[symbol.toUpperCase()];

      if (!coinId) {
        // Try to search for the coin
        const searchResponse = await fetch(
          `https://api.coingecko.com/api/v3/search?query=${symbol}`,
          { headers }
        );

        if (!searchResponse.ok) {
          throw new Error(`Failed to search for ${symbol}`);
        }

        const searchData = await searchResponse.json();
        const foundCoin = searchData.coins?.[0];

        if (!foundCoin) {
          throw new Error(`Coin ${symbol} not found. Try common symbols like BTC, ETH, SUI`);
        }

        // Use the found coin ID for the next request
        const response = await fetch(
          `https://api.coingecko.com/api/v3/coins/${foundCoin.id}/market_chart?vs_currency=usd&days=${days}`,
          { headers }
        );

        if (!response.ok) {
          throw new Error(`CoinGecko API error: ${response.status}`);
        }

        const data = await response.json();

        return {
          symbol: symbol.toUpperCase(),
          name: foundCoin.name,
          data: data.prices.map((item: any, index: number) => ({
            timestamp: new Date(item[0]).toISOString(),
            price: item[1],
            volume24h: data.total_volumes[index]?.[1] || 0,
            marketCap: data.market_caps[index]?.[1] || 0,
          })),
        };
      }

      // Fetch historical data from CoinGecko
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();

      // Get coin info for the name
      const infoResponse = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
        { headers }
      );

      const coinInfo = infoResponse.ok ? await infoResponse.json() : null;

      return {
        symbol: symbol.toUpperCase(),
        name: coinInfo?.name || symbol.toUpperCase(),
        data: data.prices.map((item: any, index: number) => ({
          timestamp: new Date(item[0]).toISOString(),
          price: item[1],
          volume24h: data.total_volumes[index]?.[1] || 0,
          marketCap: data.market_caps[index]?.[1] || 0,
        })),
      };
    },
  }),

  getGlobalMarketStats: tool({
    description:
      'Get global cryptocurrency market statistics including total market cap, BTC dominance, 24h volume, and number of active cryptocurrencies. Usage: getGlobalMarketStats({confirm: true})',
    inputSchema: jsonSchema<GetGlobalMarketStatsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get global market stats",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<GlobalMarketStats> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      const response = await fetch(
        'https://api.coingecko.com/api/v3/global',
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();
      const globalData = data.data;

      return {
        totalMarketCap: globalData.total_market_cap.usd,
        totalVolume24h: globalData.total_volume.usd,
        btcDominance: globalData.market_cap_percentage.btc,
        ethDominance: globalData.market_cap_percentage.eth,
        activeCryptocurrencies: globalData.active_cryptocurrencies,
        markets: globalData.markets,
        marketCapChangePercentage24h: globalData.market_cap_change_percentage_24h_usd,
      };
    },
  }),

  getFearGreedIndex: tool({
    description:
      'Get the crypto Fear & Greed Index (0-100) which measures market sentiment. Values: 0-24 = Extreme Fear, 25-49 = Fear, 50-74 = Greed, 75-100 = Extreme Greed. Usage: getFearGreedIndex({confirm: true})',
    inputSchema: jsonSchema<GetFearGreedIndexInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get fear & greed index",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<FearGreedIndex> => {
      const response = await fetch('https://api.alternative.me/fng/');

      if (!response.ok) {
        throw new Error(`Fear & Greed API error: ${response.status}`);
      }

      const data = await response.json();
      const indexData = data.data[0];

      return {
        value: parseInt(indexData.value),
        classification: indexData.value_classification,
        timestamp: new Date(parseInt(indexData.timestamp) * 1000).toISOString(),
      };
    },
  }),

  getTopCoins: tool({
    description:
      'Get top cryptocurrencies by market cap with current prices, volumes, and 24h changes. Usage: getTopCoins({confirm: true, limit: 10})',
    inputSchema: jsonSchema<GetTopCoinsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get top coins",
        },
        limit: {
          type: "number" as const,
          description: "Number of top coins to return (default: 10, max: 50)",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async ({ limit = 10 }): Promise<GetTopCoinsOutput> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      const maxLimit = Math.min(limit, 50);

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${maxLimit}&page=1&sparkline=false`,
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        coins: data.map((coin: any) => ({
          id: coin.id,
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          rank: coin.market_cap_rank,
          price: coin.current_price,
          marketCap: coin.market_cap,
          volume24h: coin.total_volume,
          percentChange24h: coin.price_change_percentage_24h,
        })),
      };
    },
  }),

  getCoinCategories: tool({
    description:
      'Get all cryptocurrency categories (DeFi, NFT, Gaming, Layer 1, etc.) with market cap and top coins. Usage: getCoinCategories({confirm: true})',
    inputSchema: jsonSchema<GetCoinCategoriesInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get coin categories",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    }),
    execute: async (): Promise<GetCoinCategoriesOutput> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      const response = await fetch(
        'https://api.coingecko.com/api/v3/coins/categories',
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        categories: data.slice(0, 20).map((cat: any) => ({
          id: cat.id,
          name: cat.name,
          marketCap: cat.market_cap || 0,
          marketCapChange24h: cat.market_cap_change_24h || 0,
          volume24h: cat.volume_24h || 0,
          topCoins: cat.top_3_coins || [],
        })),
      };
    },
  }),

  getCoinsByCategory: tool({
    description:
      'Get all coins in a specific category. First use getCoinCategories to find category IDs. Usage: getCoinsByCategory({confirm: true, categoryId: "layer-1"})',
    inputSchema: jsonSchema<GetCoinsByCategoryInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get coins by category",
        },
        categoryId: {
          type: "string" as const,
          description: "Category ID (e.g., 'layer-1', 'defi', 'nft')",
        },
      },
      required: ["confirm", "categoryId"],
      additionalProperties: false,
    }),
    execute: async ({ categoryId }): Promise<GetCoinsByCategoryOutput> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${categoryId}&order=market_cap_desc&per_page=20&page=1&sparkline=false`,
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        category: categoryId,
        coins: data.map((coin: any) => ({
          id: coin.id,
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          rank: coin.market_cap_rank,
          price: coin.current_price,
        })),
      };
    },
  }),

  getCoinDetails: tool({
    description:
      'Get detailed information about a cryptocurrency including description, website, whitepaper, blockchain, and social links. Usage: getCoinDetails({confirm: true, coinId: "bitcoin"})',
    inputSchema: jsonSchema<GetCoinDetailsInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to get coin details",
        },
        coinId: {
          type: "string" as const,
          description: "CoinGecko coin ID (e.g., 'bitcoin', 'ethereum', 'sui')",
        },
      },
      required: ["confirm", "coinId"],
      additionalProperties: false,
    }),
    execute: async ({ coinId }): Promise<CoinDetails> => {
      const apiKey = process.env.COINGECKO_API_KEY;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (apiKey) {
        headers['x-cg-demo-api-key'] = apiKey;
      }

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
        { headers }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        id: data.id,
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        description: data.description?.en?.substring(0, 500) || 'No description available',
        homepage: data.links?.homepage?.[0] || null,
        whitepaper: data.links?.whitepaper || null,
        blockchain: data.asset_platform_id || null,
        genesisDate: data.genesis_date || null,
        marketCapRank: data.market_cap_rank || 0,
      };
    },
  }),

  showDiagram: tool({
    description:
      'Display educational flow diagrams about Sui ecosystem technologies. Available diagrams: zklogin (OAuth authentication), nautilus (Sui framework), seal (security), walrus (storage). Use when users ask about these topics. Usage: showDiagram({confirm: true, diagramType: "zklogin"})',
    inputSchema: jsonSchema<ShowDiagramInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to show the diagram",
        },
        diagramType: {
          type: "string" as const,
          enum: ["zklogin", "nautilus", "seal", "walrus"],
          description: "Type of diagram to show: zklogin (authentication), nautilus (Sui framework), seal (security), walrus (storage)",
        },
      },
      required: ["confirm", "diagramType"],
      additionalProperties: false,
    }),
    execute: async ({ diagramType }): Promise<ShowDiagramOutput> => {
      const diagrams = {
        zklogin: {
          title: 'zkLogin Authentication Flow',
          svgPath: '/zk-login-flow.svg',
          docsUrl: 'https://docs.sui.io/concepts/cryptography/zklogin',
        },
        nautilus: {
          title: 'Nautilus Framework Flow',
          svgPath: '/nautilus-flow.svg',
          docsUrl: 'https://docs.sui.io',
        },
        seal: {
          title: 'Seal Security Flow',
          svgPath: '/seal-flow.svg',
          docsUrl: 'https://docs.sui.io',
        },
        walrus: {
          title: 'Walrus Storage Flow',
          svgPath: '/walrus-flow.svg',
          docsUrl: 'https://docs.walrus.site',
        },
      };

      const diagram = diagrams[diagramType];

      return {
        diagramType,
        title: diagram.title,
        svgPath: diagram.svgPath,
        docsUrl: diagram.docsUrl,
      };
    },
  }),

  searchUserMemories: tool({
    description:
      'Search the user\'s saved memories using semantic search. Returns memories stored on the blockchain that are semantically similar to the query. Use this to recall user preferences, past conversations, important facts, and context from previous interactions. Usage: searchUserMemories({confirm: true, query: "what did I say about my favorite food?", limit: 5})',
    inputSchema: jsonSchema<SearchUserMemoriesInput>({
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          description: "Set to true to search memories",
        },
        query: {
          type: "string" as const,
          description: "Search query to find relevant memories (e.g., 'user preferences', 'past decisions', 'important facts')",
        },
        limit: {
          type: "number" as const,
          description: "Maximum number of memories to return (default: 10, max: 50)",
        },
      },
      required: ["confirm", "query"],
      additionalProperties: false,
    }),
    execute: async ({ query, limit = 10 }): Promise<SearchUserMemoriesOutput> => {
      try {
        const result = await recallMemories(query, Math.min(limit, 50));

        const memories: UserMemory[] = result.results.map((r) => ({
          id: '',
          text: r.text,
          category: 'general',
          importance: 5,
          similarity: 1 - r.distance,
          createdAt: new Date().toISOString(),
        }));
        return {
          query,
          memories,
          count: memories.length,
        };
      } catch (error) {
        console.error('[Tool] searchUserMemories error:', error);

        return {
          query,
          memories: [],
          count: 0,
          error: "Memory search unavailable",
        };
      }
    },
  }),
});
