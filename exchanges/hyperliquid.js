const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class HyperliquidExchange {
    constructor() {
        this.name = 'Hyperliquid';
        this.proxyAgent = getProxyAgent();
        this.fundingMap = {};
        this.tickersMap = {};
        this.baseUrl = 'https://api.hyperliquid.xyz';
        this.universe = []; // 存储所有可用的合约信息
        this.maxRetries = 3;
        this.requestTimeout = 15000;
    }

    async initialize() {
        try {
            await this.loadMarkets();
            logger.exchangeInit('hyperliquid', true);
        } catch (error) {
            logger.exchangeInit('hyperliquid', false, error);
            throw error;
        }
    }

    // 加载市场信息，获取 universe (所有可用合约)
    async loadMarkets() {
        try {
            const response = await axios.post(`${this.baseUrl}/info`, {
                type: 'meta'
            }, {
                headers: { 'Content-Type': 'application/json' },
                httpsAgent: this.proxyAgent,
                timeout: this.requestTimeout
            });

            if (response.data && response.data.universe) {
                this.universe = response.data.universe;
                logger.exchangeSuccess('hyperliquid', 'MARKETS', `Loaded ${this.universe.length} markets`);
            } else {
                throw new Error('Failed to get universe data from Hyperliquid');
            }
        } catch (error) {
            logger.exchangeError('hyperliquid', 'MARKETS', 'Failed to load markets', error);
            throw error;
        }
    }

    // 获取价格数据，使用 metaAndAssetCtxs 类型获取 midPx、markPx 等
    async fetchTickers() {
        try {
            const response = await axios.post(`${this.baseUrl}/info`, {
                type: 'metaAndAssetCtxs'
            }, {
                headers: { 'Content-Type': 'application/json' },
                httpsAgent: this.proxyAgent,
                timeout: this.requestTimeout
            });

            if (!response.data || !Array.isArray(response.data) || response.data.length < 2) {
                throw new Error('Invalid metaAndAssetCtxs response structure');
            }

            const [metaData, assetCtxs] = response.data;
            const universe = metaData.universe;
            
            if (!Array.isArray(universe) || !Array.isArray(assetCtxs)) {
                throw new Error('Invalid universe or assetCtxs data');
            }

            this.tickersMap = {};
            let processed = 0;
            let failed = 0;

            for (let i = 0; i < Math.min(universe.length, assetCtxs.length); i++) {
                try {
                    const coin = universe[i];
                    const ctx = assetCtxs[i];

                    if (!coin || !coin.name || !ctx) {
                        failed++;
                        continue;
                    }

                    // 标准化符号格式：BTC -> BTC/USDC:USDC 
                    // 符合现有聚合系统的 BASE/QUOTE:SETTLEMENT 格式
                    const symbol = `${coin.name}/USDC:USDC`;
                    
                    const timestamp = Date.now();
                    const midPx = ctx.midPx ? parseFloat(ctx.midPx) : null;
                    const markPx = ctx.markPx ? parseFloat(ctx.markPx) : null;
                    const oraclePx = ctx.oraclePx ? parseFloat(ctx.oraclePx) : null;
                    const prevDayPx = ctx.prevDayPx ? parseFloat(ctx.prevDayPx) : null;
                    const dayNtlVlm = ctx.dayNtlVlm ? parseFloat(ctx.dayNtlVlm) : null;

                    this.tickersMap[symbol] = {
                        symbol,
                        timestamp,
                        datetime: new Date(timestamp).toISOString(),
                        high: null, // Hyperliquid 不直接提供 24h high/low
                        low: null,
                        bid: ctx.impactPxs && ctx.impactPxs[0] ? parseFloat(ctx.impactPxs[0]) : null,
                        bidVolume: null,
                        ask: ctx.impactPxs && ctx.impactPxs[1] ? parseFloat(ctx.impactPxs[1]) : null,
                        askVolume: null,
                        vwap: null,
                        open: prevDayPx,
                        close: midPx,
                        last: midPx,
                        previousClose: prevDayPx,
                        change: (midPx && prevDayPx) ? midPx - prevDayPx : null,
                        percentage: (midPx && prevDayPx && prevDayPx > 0) ? ((midPx - prevDayPx) / prevDayPx) * 100 : null,
                        average: markPx,
                        baseVolume: dayNtlVlm, // 使用日成交量
                        quoteVolume: null,
                        info: {
                            coin: coin.name,
                            szDecimals: coin.szDecimals,
                            maxLeverage: coin.maxLeverage,
                            onlyIsolated: coin.onlyIsolated || false,
                            isDelisted: coin.isDelisted || false,
                            markPx,
                            oraclePx,
                            openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : null,
                            premium: ctx.premium ? parseFloat(ctx.premium) : null,
                            funding: ctx.funding ? parseFloat(ctx.funding) : null,
                            impactPxs: ctx.impactPxs
                        }
                    };
                    processed++;
                } catch (itemError) {
                    failed++;
                    logger.exchangeError('hyperliquid', 'TICKER', `Failed to process ticker for ${universe[i]?.name || 'unknown'}`, itemError);
                }
            }

            if (config.logging.enableTickerLogs) {
                logger.tickerSuccess('hyperliquid', `Processed ${processed} tickers, failed ${failed}`);
            }

            return this.tickersMap;
        } catch (error) {
            logger.exchangeError('hyperliquid', 'TICKER', 'Failed to fetch tickers', error);
            throw error;
        }
    }

    // 获取资金费率数据
    async fetchFundingInfo() {
        try {
            const response = await axios.post(`${this.baseUrl}/info`, {
                type: 'metaAndAssetCtxs'
            }, {
                headers: { 'Content-Type': 'application/json' },
                httpsAgent: this.proxyAgent,
                timeout: this.requestTimeout
            });

            if (!response.data || !Array.isArray(response.data) || response.data.length < 2) {
                throw new Error('Invalid metaAndAssetCtxs response structure');
            }

            const [metaData, assetCtxs] = response.data;
            const universe = metaData.universe;

            if (!Array.isArray(universe) || !Array.isArray(assetCtxs)) {
                throw new Error('Invalid universe or assetCtxs data');
            }

            this.fundingMap = {};
            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < Math.min(universe.length, assetCtxs.length); i++) {
                try {
                    const coin = universe[i];
                    const ctx = assetCtxs[i];

                    if (!coin || !coin.name || !ctx || ctx.funding === undefined) {
                        errorCount++;
                        continue;
                    }

                    const symbol = `${coin.name}/USDC:USDC`;
                    const fundingRate = parseFloat(ctx.funding);
                    
                    // Hyperliquid 资金费率每小时结算，计算下一个整点时间
                    const now = new Date();
                    const nextHour = new Date(now);
                    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
                    const nextFundingTime = nextHour.getTime();

                    this.fundingMap[symbol] = {
                        fundingRate,
                        fundingTime: nextFundingTime,
                        fundingInterval: 1, // 每小时
                        premium: ctx.premium ? parseFloat(ctx.premium) : null,
                        markPx: ctx.markPx ? parseFloat(ctx.markPx) : null,
                        oraclePx: ctx.oraclePx ? parseFloat(ctx.oraclePx) : null
                    };
                    successCount++;

                    if (config.logging.enableDetailedFunding) {
                        logger.fundingSuccess('hyperliquid', `${coin.name} -> ${symbol}`, {
                            fundingRate: ctx.funding,
                            nextFundingTime,
                            premium: ctx.premium
                        });
                    }
                } catch (itemError) {
                    errorCount++;
                    logger.fundingError('hyperliquid', `Failed to process funding for ${universe[i]?.name || 'unknown'}`, itemError);
                }
            }

            const totalSymbols = Math.min(universe.length, assetCtxs.length);
            logger.fundingSummary('hyperliquid', 'Funding rate fetch completed', {
                successCount,
                errorCount,
                totalSymbols
            });

            return this.fundingMap;
        } catch (error) {
            logger.exchangeError('hyperliquid', 'FUNDING', 'Failed to fetch funding info', error);
            throw error;
        }
    }

    getFundingMap() {
        return this.fundingMap;
    }

    // 为了对齐接口，提供空的 WebSocket 状态方法
    getConnectionStatus() {
        return {
            connected: true, // REST API 模式下默认连接
            reconnectAttempts: 0,
            totalReconnects: 0,
            lastMessageTime: Date.now(),
            connectionUptime: Date.now(),
            cachedTickers: Object.keys(this.tickersMap).length,
            lastErrorType: null,
            consecutiveErrors: 0
        };
    }

    disconnect() {
        // REST API 模式下无需断开连接
        logger.exchangeInfo('hyperliquid', 'DISCONNECT', 'Exchange disconnected');
    }
}

module.exports = HyperliquidExchange;