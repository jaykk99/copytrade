// Shared constants for the copytrade paper-trading app.
export const CONFIG = {
  APP_NAME: 'CopyTrade Paper',
  PAPER_STARTING_BALANCE_USD: 10000,
  PAPER_FEE_RATE: 0.001, // 0.1% per side, paper only
  PRICE_REFRESH_MS: 30000,
  PRICE_STALE_MS: 120000,
  // CoinGecko ids mapped to our symbols (free, keyless)
  SYMBOLS: {
    BTC: { coingeckoId: 'bitcoin',   name: 'Bitcoin',  decimals: 6 },
    ETH: { coingeckoId: 'ethereum',  name: 'Ethereum', decimals: 5 },
    SOL: { coingeckoId: 'solana',    name: 'Solana',   decimals: 4 },
    BNB: { coingeckoId: 'binancecoin', name: 'BNB',    decimals: 4 },
    XRP: { coingeckoId: 'ripple',    name: 'XRP',      decimals: 2 },
    DOGE:{ coingeckoId: 'dogecoin',  name: 'Dogecoin', decimals: 2 },
    ADA: { coingeckoId: 'cardano',   name: 'Cardano',   decimals: 2 },
    AVAX:{ coingeckoId: 'avalanche-2', name: 'Avalanche', decimals: 4 },
    // Liquid-staking / liquid-restaking plays (Jay's watchlist)
    STONE:{ coingeckoId: 'stakestone-ether', name: 'StakeStone ETH', decimals: 2 },
    LDO: { coingeckoId: 'lido-dao', name: 'Lido DAO', decimals: 4 },
    RPL: { coingeckoId: 'rocket-pool', name: 'Rocket Pool', decimals: 3 },
    JTO: { coingeckoId: 'jito-governance-token', name: 'Jito', decimals: 3 },
    JUP: { coingeckoId: 'jupiter-exchange-solana', name: 'Jupiter', decimals: 3 },
    ENA: { coingeckoId: 'ethena', name: 'Ethena', decimals: 3 },
  },
  COINGECKO_URL: 'https://api.coingecko.com/api/v3/simple/price',
  COINCAP_URL: 'https://api.coincap.io/v2/assets',
  BLOCKCHAIR_URL: 'https://api.blockchair.com',
  STORAGE_KEY: 'copytrade_paper_v1',
};
