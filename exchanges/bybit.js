const ccxt = require('ccxt');
const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class BybitExchange {
    constructor() {
        this.name = 'Bybit';
        this.exchange = null;
        this.fundingMap = {};
        this.proxyAgent = getProxyAgent();
    }
    
    async initialize() {
        try {
            this.exchange = new ccxt.bybit({ 
                'agent': this.proxyAgent,
                'options': {
                    'defaultType': 'linear', // bybit永续合约使用linear
                },
            });
            
            await this.exchange.loadMarkets();
            logger.exchangeInit('bybit', 'Exchange initialized successfully');
        } catch (error) {
            logger.exchangeError('bybit', 'initialization', 'Failed to initialize exchange', error);
            throw error;
        }
    }
    
    async fetchTickers() {
        try {
            const tickers = await this.exchange.fetchTickers();
            
            if (config.logging.enableTickerLogs) {
                logger.tickerSuccess('bybit', `Fetched ${Object.keys(tickers).length} tickers`);
            }
            
            return tickers;
        } catch (error) {
            logger.tickerError('bybit', 'Failed to fetch tickers', error);
            return {};
        }
    }
    
    async fetchFundingInfo() {
        try {
            logger.fundingInfo('bybit', 'Starting funding rate fetch');
            
            // 获取交易对信息
            const instrumentsResponse = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
                params: {
                    category: 'linear',
                    limit: 1000,
                },
                httpsAgent: this.proxyAgent
            });

            // 获取当前资金费率信息
            const response = await axios.get('https://api.bybit.com/v5/market/tickers', {
                params: {
                    category: 'linear'
                },
                httpsAgent: this.proxyAgent
            });

            if (response.data && response.data.result && response.data.result.list) {
                this.fundingMap = {};
                let successCount = 0;
                let errorCount = 0;
                
                for (const item of response.data.result.list) {
                    try {
                        if (item.fundingRate && item.nextFundingTime) {
                            const symbol = item.symbol.replace('USDT', '/USDT:USDT');
                            
                            this.fundingMap[symbol] = {
                                fundingRate: parseFloat(item.fundingRate),
                                fundingTime: parseInt(item.nextFundingTime),
                                fundingInterval: 8
                            };
                            
                            successCount++;
                            
                            if (config.logging.enableDetailedFunding) {
                                logger.fundingSuccess('bybit', `${item.symbol} -> ${symbol}`, {
                                    fundingRate: item.fundingRate,
                                    nextFundingTime: item.nextFundingTime
                                });
                            }
                        } else {
                            errorCount++;
                            if (config.logging.enableDetailedFunding) {
                                logger.fundingError('bybit', `Missing funding data for ${item.symbol}`, {
                                    hasFundingRate: !!item.fundingRate,
                                    hasNextFundingTime: !!item.nextFundingTime
                                });
                            }
                        }
                    } catch (itemError) {
                        errorCount++;
                        logger.fundingError('bybit', `Failed to process funding data for ${item.symbol}`, itemError);
                    }
                }

                logger.fundingSummary('bybit', 'Funding rate fetch completed', {
                    successCount,
                    errorCount,
                    totalSymbols: Object.keys(this.fundingMap).length,
                    totalReceived: response.data.result.list.length
                });
            } else {
                logger.fundingError('bybit', 'Invalid response format', {
                    hasData: !!response.data,
                    hasResult: !!response.data?.result,
                    hasList: !!response.data?.result?.list
                });
            }

        } catch (error) {
            logger.fundingError('bybit', 'Error fetching funding rates', error);
        }
    }
    
    getFundingMap() {
        return this.fundingMap;
    }
}

module.exports = BybitExchange;