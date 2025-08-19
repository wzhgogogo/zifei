const ccxt = require('ccxt');
const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class OKXExchange {
    constructor() {
        this.name = 'OKX';
        this.exchange = null;
        this.fundingMap = {};
        this.proxyAgent = getProxyAgent();
    }
    
    async initialize() {
        try {
            this.exchange = new ccxt.okx({ 
                'agent': this.proxyAgent,
                'options': {
                    'defaultType': 'swap',
                },
            });
            
            await this.exchange.loadMarkets();
            logger.exchangeInit('okx', 'Exchange initialized successfully');
        } catch (error) {
            logger.exchangeError('okx', 'initialization', 'Failed to initialize exchange', error);
            throw error;
        }
    }
    
    async fetchTickers() {
        try {
            const tickers = await this.exchange.fetchTickers();
            
            if (config.logging.enableTickerLogs) {
                logger.tickerSuccess('okx', `Fetched ${Object.keys(tickers).length} tickers`);
            }
            
            return tickers;
        } catch (error) {
            logger.tickerError('okx', 'Failed to fetch tickers', error);
            return {};
        }
    }
    
    async fetchFundingInfo() {
        try {
            const markets = this.exchange.markets;
            const swapSymbols = Object.values(markets)
                .filter(m => m.swap && m.quote === 'USDT')
                .map(m => m.id);

            if (swapSymbols.length === 0) {
                logger.fundingWarn('No USDT perpetual symbols found, skipping funding rate update', {
                    exchange: 'okx'
                });
                return;
            }

            logger.fundingInfo('okx', `Starting funding rate fetch for ${swapSymbols.length} symbols`);

            this.fundingMap = {};
            let successCount = 0;
            let errorCount = 0;
            
            await Promise.all(swapSymbols.map(async (instId) => {
                try {
                    const response = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
                        params: { instId },
                        httpsAgent: this.proxyAgent
                    });

                    if (response.data.code === '0' && response.data.data && response.data.data.length > 0) {
                        const item = response.data.data[0];
                        const symbol = this.exchange.safeSymbol(item.instId);
                        if (symbol) {
                            const fundingTime = parseInt(item.fundingTime);
                            const nextFundingTime = parseInt(item.nextFundingTime);
                            const fundingInterval = Math.floor((nextFundingTime - fundingTime) / 1000 / 60 / 60);
                            
                            this.fundingMap[symbol] = {
                                fundingRate: parseFloat(item.fundingRate),
                                fundingTime: fundingTime,
                                fundingInterval: fundingInterval
                            };
                            
                            successCount++;
                            
                            if (config.logging.enableDetailedFunding) {
                                logger.fundingSuccess('okx', `${instId} -> ${symbol}`, {
                                    fundingRate: item.fundingRate,
                                    fundingTime: fundingTime,
                                    fundingInterval
                                });
                            }
                        }
                    } else {
                        errorCount++;
                        logger.fundingError('okx', `Invalid response for ${instId}`, {
                            code: response.data.code,
                            dataLength: response.data.data?.length
                        });
                    }
                } catch (e) {
                    errorCount++;
                    if (config.logging.enableDetailedFunding) {
                        logger.fundingError('okx', `Failed to fetch funding rate for ${instId}`, e);
                    }
                }
            }));

            logger.fundingSummary('okx', 'Funding rate fetch completed', {
                successCount,
                errorCount,
                totalSymbols: Object.keys(this.fundingMap).length
            });

        } catch (error) {
            logger.fundingError('okx', 'Error in fetchFundingInfo', error);
        }
    }
    
    getFundingMap() {
        return this.fundingMap;
    }
}

module.exports = OKXExchange;