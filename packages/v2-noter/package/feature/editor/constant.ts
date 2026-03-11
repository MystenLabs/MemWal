/**
 * Static crypto coin data for mentions
 */

export interface CoinData {
  id: string;
  symbol: string;
  name: string;
  icon?: string;
  color?: string;
}

export const COINS: CoinData[] = [
  {
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    color: '#F7931A',
  },
  {
    id: 'ethereum',
    symbol: 'ETH',
    name: 'Ethereum',
    color: '#627EEA',
  },
  {
    id: 'sui',
    symbol: 'SUI',
    name: 'Sui',
    color: '#4DA2FF',
  },
  {
    id: 'solana',
    symbol: 'SOL',
    name: 'Solana',
    color: '#14F195',
  },
  {
    id: 'cardano',
    symbol: 'ADA',
    name: 'Cardano',
    color: '#0033AD',
  },
  {
    id: 'polkadot',
    symbol: 'DOT',
    name: 'Polkadot',
    color: '#E6007A',
  },
  {
    id: 'avalanche',
    symbol: 'AVAX',
    name: 'Avalanche',
    color: '#E84142',
  },
  {
    id: 'polygon',
    symbol: 'MATIC',
    name: 'Polygon',
    color: '#8247E5',
  },
  {
    id: 'chainlink',
    symbol: 'LINK',
    name: 'Chainlink',
    color: '#375BD2',
  },
  {
    id: 'uniswap',
    symbol: 'UNI',
    name: 'Uniswap',
    color: '#FF007A',
  },
];

/**
 * Search coins by symbol or name
 */
export function searchCoins(query: string): CoinData[] {
  if (!query) return COINS;

  const lowerQuery = query.toLowerCase();
  return COINS.filter(
    (coin) =>
      coin.symbol.toLowerCase().includes(lowerQuery) ||
      coin.name.toLowerCase().includes(lowerQuery)
  );
}
