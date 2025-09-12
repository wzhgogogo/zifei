const axios = require('axios');
const WebSocket = require('ws');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class BackpackExchange {
    constructor() {
        this.name = 'Backpack';
        this.exchange = null;
        this.fundingMap = {};
        this.proxyAgent = getProxyAgent();
        this.ws = null;
        this.tickers = {};
        this.baseUrl = 'https://api.backpack.exchange';
        this.wsUrl = 'wss://ws.backpack.exchange';
        this.reconnectInterval = 5000;
        this.pingInterval = 30000;
        this.isConnecting = false;
        this.markets = {};
    }

    async initialize() {
        try {
            // 首先获取市场信息
            await this.loadMarkets();

            // 初始化 WebSocket 连接
            await this.connectWebSocket();

            logger.exchangeInit('backpack', true, 'Exchange initialized successfully');
        } catch (error) {
            logger.exchangeError('backpack1', null, 'initialization', 'Failed to initialize exchange', error);
            throw error;
        }
    }

    async loadMarkets() {
        try {
            logger.exchangeInfo('backpack', null, 'markets', 'Loading markets data');

            const response = await axios.get(`${this.baseUrl}/api/v1/markets`, {
                httpsAgent: this.proxyAgent,
                timeout: 10000
            });

            if (response.data && Array.isArray(response.data)) {
                this.markets = {};
                response.data.forEach(market => {
                    // 统一使用大写符号作为键
                    const sym = market.symbol;
                    this.markets[sym] = { ...market, symbol: sym };
                });

                const perpCount = Object.keys(this.markets).filter(s => s.endsWith('_PERP')).length;
                logger.exchangeSuccess('backpack', null, 'markets', `Loaded ${response.data.length} markets`, {
                    totalMarkets: response.data.length,
                    perpMarkets: perpCount
                });
            }
        } catch (error) {
            logger.exchangeError('backpack5', null, 'markets', 'Failed to load markets', error);
            throw error;
        }
    }

    async connectWebSocket() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        this.isConnecting = true;

        try {
            logger.websocket('backpack', null, 'Connecting to WebSocket');

            this.ws = new WebSocket(this.wsUrl, {
                agent: this.proxyAgent
            });

            this.ws.on('open', () => {
                logger.websocket('backpack', null, 'WebSocket connected successfully');
                this.isConnecting = false;

                // 订阅所有市场的ticker数据
                this.subscribeToTickers();

                // 设置心跳
                this.startPing();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (error) {
                    logger.exchangeError('backpack2', null, 'websocket', 'Failed to parse WebSocket message', error);
                }
            });

            this.ws.on('close', () => {
                logger.exchangeWarn('backpack', null, 'websocket', 'WebSocket disconnected, attempting to reconnect');
                this.isConnecting = false;
                this.scheduleReconnect();
            });

            this.ws.on('error', (error) => {
                logger.exchangeError('backpack3', null, 'websocket', 'WebSocket error occurred', error);
                this.isConnecting = false;
            });

        } catch (error) {
            logger.exchangeError('backpack4', null, 'websocket', 'Failed to create WebSocket connection', error);
            this.isConnecting = false;
            this.scheduleReconnect();
        }
    }

    subscribeToTickers() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // 订阅所有 PERP 合约（大写且以 _PERP 结尾）
        const perpSymbols = Object.keys(this.markets).filter(symbol => symbol.endsWith('_PERP'));
        const tickerStreams = perpSymbols.map(symbol => `ticker.${symbol}`);

        const subscribeMessage = {
            method: 'SUBSCRIBE',
            params: tickerStreams
        };

        this.ws.send(JSON.stringify(subscribeMessage));

        if (config.logging.enableTickerLogs) {
            logger.tickerInfo('backpack', null, `Subscribed to ${tickerStreams.length} PERP ticker streams`);
        }
    }

    handleMessage(message) {
        if (message.stream && message.data) {
            const [streamType, symbol] = message.stream.split('.');

            switch (streamType) {
                case 'ticker':
                    this.handleTickerUpdate(symbol, message.data);
                    break;
                default:
                    // 处理其他类型的消息
                    break;
            }
        }
    }

    handleTickerUpdate(symbol, data) {
        // 将 Backpack 符号统一到 BASE/USDT:USDT，便于与其他交易所合并
        const unifiedSymbol = this.convertSymbolToUnified(symbol);
        this.tickers[unifiedSymbol] = {
            symbol: unifiedSymbol,
            last: parseFloat(data.c || data.lastPrice),
            bid: parseFloat(data.b || data.bidPrice),
            ask: parseFloat(data.a || data.askPrice),
            high: parseFloat(data.h || data.highPrice),
            low: parseFloat(data.l || data.lowPrice),
            volume: parseFloat(data.v || data.volume),
            quoteVolume: parseFloat(data.q || data.quoteVolume),
            change: parseFloat(data.P || data.priceChangePercent),
            timestamp: parseInt(data.E || Date.now())
        };
    }

    startPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }

        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, this.pingInterval);
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            this.connectWebSocket();
        }, this.reconnectInterval);
    }

    convertSymbolToUnified(symbol) {
        // Backpack: BTC_USDC_PERP -> 统一为 BTC/USDT:USDT（按你的要求合并到 USDT 桶）
        const sym = (symbol || '').toUpperCase();
        if (sym.endsWith('_PERP')) {
            const base = sym.split('_')[0];
            return `${base}/USDT:USDT`;
        }
        // 其他情况保底返回大写
        return sym;
    }

    async fetchTickers() {
        try {
            // 如果WebSocket数据可用，返回实时数据（此处的键已统一为 /USDT:USDT）
            if (Object.keys(this.tickers).length > 0) {
                return this.tickers;
            }

            // 如果WebSocket数据不可用，使用REST API获取
            logger.tickerInfo('backpack', null, 'Fetching tickers via REST API (WebSocket data unavailable)');

            const response = await axios.get(`${this.baseUrl}/api/v1/tickers`, {
                httpsAgent: this.proxyAgent,
                timeout: 10000
            });

            const tickers = {};
            if (response.data && Array.isArray(response.data)) {
                response.data.forEach(ticker => {
                    const symbol = (ticker.symbol || '').toUpperCase();
                    if (symbol.endsWith('_PERP')) {
                        const unifiedSymbol = this.convertSymbolToUnified(symbol);
                        tickers[unifiedSymbol] = {
                            symbol: unifiedSymbol,
                            last: parseFloat(ticker.lastPrice || ticker.c),
                            bid: parseFloat(ticker.bidPrice || ticker.b),
                            ask: parseFloat(ticker.askPrice || ticker.a),
                            high: parseFloat(ticker.highPrice || ticker.h),
                            low: parseFloat(ticker.lowPrice || ticker.l),
                            volume: parseFloat(ticker.volume || ticker.v),
                            quoteVolume: parseFloat(ticker.quoteVolume || ticker.q),
                            change: parseFloat(ticker.priceChangePercent || ticker.P),
                            timestamp: parseInt(ticker.closeTime || ticker.E || Date.now())
                        };
                    }
                });
            }

            if (config.logging.enableTickerLogs) {
                logger.tickerSuccess('backpack', null, `Fetched ${Object.keys(tickers).length} tickers via REST API`);
            }

            return tickers;
        } catch (error) {
            logger.tickerError('backpack', 'Failed to fetch tickers:' + error);
            return {};
        }
    }

    async fetchFundingInfo(symbols) {
        try {
            // 删除有问题的CCXT逻辑，直接使用HTTP API实现

            // 仅 _PERP 合约
            const futureMarkets = Object.values(this.markets).filter(market =>
                (market.symbol || '').endsWith('_PERP')
            );

            logger.fundingInfo('backpack', `Starting funding rate fetch for ${futureMarkets.length} PERP markets`);

            if (futureMarkets.length === 0) {
                // 修正参数：fundingWarn 只有 (message, data)
                logger.fundingWarn('[backpack] No PERP markets found, skipping funding rate update');
                return;
            }

            // 原来这里是：this.fundingMap = {};
            const newFundingMap = {};
            let successCount = 0;
            let errorCount = 0;

            // 使用正确的 /api/v1/fundingRates 端点
            await Promise.all(futureMarkets.map(async (market) => {
                const symbol = market.symbol;
                if (symbol && symbol.length > 0) {
                    try {
                        if (config.logging.enableDetailedFunding) {
                            logger.fundingInfo('backpack', `Fetching funding rate for symbol: ${symbol}`);
                        }

                        // 使用重试机制的请求函数
                        const fetchWithRetry = async (symbol, retries = 2) => {
                            for (let i = 0; i <= retries; i++) {
                                try {
                                    const response = await axios.get(`${this.baseUrl}/api/v1/fundingRates`, {
                                        params: { symbol },
                                        httpsAgent: this.proxyAgent,
                                        timeout: 10000
                                    });
                                    return response;
                                } catch (error) {
                                    if (i === retries) throw error;
                                    if (error.response?.status === 400) {
                                        throw error; // 400错误不重试
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                                }
                            }
                        };

                        const response = await fetchWithRetry(symbol);

                        if (config.logging.enableDetailedFunding) {
                            logger.fundingInfo('backpack', `Funding rates response for ${symbol}`, {
                                responseType: typeof response.data,
                                dataLength: response.data?.length,
                                sample: response.data?.[0]
                            });
                        }

                        // 根据Python代码，响应应该是一个数组，取第一个元素（最新的资金费率）
                        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
                            const latestFunding = response.data[0];

                            if (latestFunding.fundingRate !== undefined) {
                                const unifiedSymbol = this.convertSymbolToUnified(symbol);

                                // 统一的时间解析：支持 ms、s、数字字符串、ISO 字符串（无时区默认按 UTC 处理）
                                function parseFlexibleTimeToMs(value) {
                                    if (value == null) return null;
                                    if (typeof value === 'number') {
                                        return value > 1e12 ? value : Math.round(value * 1000);
                                    }
                                    if (typeof value === 'string') {
                                        const trimmed = value.trim();
                                        if (/^\d+(\.\d+)?$/.test(trimmed)) {
                                            const num = Number(trimmed);
                                            return num > 1e12 ? num : Math.round(num * 1000);
                                        }
                                        // 处理 ISO 字符串：无时区信息时按 UTC 解析
                                        const hasTZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed);
                                        const iso = hasTZ ? trimmed : `${trimmed}Z`;
                                        const t = Date.parse(iso);
                                        return Number.isNaN(t) ? null : t;
                                    }
                                    return null;
                                }

                                const intervalHours = Number(latestFunding.fundingIntervalHours) || 8;
                                const intervalMs = intervalHours * 60 * 60 * 1000;

                                const nfCandidates = [
                                    latestFunding.nextFundingTime,
                                    latestFunding.nextFundingAt,
                                    latestFunding.nextFundingTimestamp,
                                    latestFunding.nextFunding,
                                    latestFunding.nextFundingTs,
                                    latestFunding.nextFundingTimeMs,
                                    latestFunding.nextFundingTimeSec,
                                    // 新增：Backpack 返回的区间结束时间字段，作为 nextFundingTime 的候选
                                    latestFunding.intervalEndTimestamp,
                                    latestFunding.intervalEnd,
                                    latestFunding.endTimestamp,
                                    latestFunding.endTime
                                ];
                                const ftCandidates = [
                                    latestFunding.fundingTime,
                                    latestFunding.fundingTimestamp,
                                    latestFunding.fundingAt,
                                    latestFunding.timestamp,
                                    latestFunding.time,
                                    latestFunding.ts,
                                    latestFunding.createdAt,
                                    latestFunding.updatedAt
                                ];

                                const firstNonNull = (arr) => arr.find(v => v != null);
                                // 修复：使用已定义的解析函数，替换 normalizeToMs
                                const nfMs = parseFlexibleTimeToMs(firstNonNull(nfCandidates));
                                const ftMs = parseFlexibleTimeToMs(firstNonNull(ftCandidates));

                                let nextFundingTimeMs = null;
                                if (nfMs != null) {
                                    nextFundingTimeMs = nfMs;
                                } else if (ftMs != null) {
                                    nextFundingTimeMs = ftMs + intervalMs;
                                } else {
                                    if (config.logging.enableDetailedFunding) {
                                        // 修正参数：message 放第一位，并明确可用键
                                        logger.fundingWarn(`[backpack] No parsable funding time for ${symbol}`, {
                                            availableKeys: Object.keys(latestFunding),
                                            candidates: {
                                                nextFunding: nfCandidates,
                                                fundingTime: ftCandidates
                                            }
                                        });
                                    }
                                }

                                // 将结果写入临时 map，避免本轮失败清空历史数据
                                newFundingMap[unifiedSymbol] = {
                                    fundingRate: parseFloat(latestFunding.fundingRate),
                                    fundingTime: nextFundingTimeMs,
                                    nextFundingTime: nextFundingTimeMs,
                                    fundingInterval: intervalHours
                                };
                                successCount++;

                                if (config.logging.enableDetailedFunding) {
                                    // 修正参数：fundingSuccess(exchange, message, data)
                                    logger.fundingSuccess('backpack', `${symbol} -> ${unifiedSymbol}`, {
                                        fundingRate: latestFunding.fundingRate,
                                        nextFundingTimeMs
                                    });
                                }
                            } else {
                                // 用 exchangeWarn 记录缺字段，并带 data
                                logger.exchangeWarn('backpack', 'FUNDING', `No fundingRate field for ${symbol}`, {
                                    availableFields: Object.keys(latestFunding)
                                });
                            }
                        } else {
                            errorCount++;
                            // 第337-340行
                            logger.fundingError('backpack', `Invalid response format for ${symbol}`, {
                                message: 'Response data is not a valid array or is empty'
                            });
                        }
                    } catch (e) {
                        errorCount++;
                        if (e.response?.status === 400) {
                            logger.fundingWarn('backpack', `Symbol ${symbol} not supported for funding rates`, {
                                statusCode: e.response.status
                            });
                        } else {
                            logger.fundingError('backpack', null, `Funding fetch failed for ${symbol}`, e);
                        }
                    }
                }
            }));

            // 只有本轮有成功才替换，避免把上一轮成功数据清空
            if (successCount > 0) {
                this.fundingMap = newFundingMap;
            }

            logger.fundingSummary('backpack', 'Funding rate fetch completed', {
                successCount,
                errorCount,
                totalSymbols: Object.keys(this.fundingMap).length
            });
        } catch (error) {
            logger.fundingError('backpack', `Failed to fetch funding info: ${error.message}`, error);
        }
    }

    getFundingMap() {
        return this.fundingMap;
    }

    disconnect() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }

        logger.exchangeInfo('backpack', null, 'disconnect', 'Exchange disconnected');
    }
}

module.exports = BackpackExchange;