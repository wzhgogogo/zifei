const ccxt = require('ccxt');
const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');
// 引入 WebSocket
const WebSocket = require('ws');

class OKXExchange {
    constructor() {
        this.name = 'OKX';
        this.exchange = null;
        this.fundingMap = {};
        this.proxyAgent = getProxyAgent();

        // WebSocket 状态与缓存
        this.ws = null;
        this.isConnected = false;
        this.tickersMap = {};
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.lastMessageTime = null;
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
            // 仅订阅 USDT 永续
            const instIds = Object.values(this.exchange.markets)
                .filter(m => m.swap && m.quote === 'USDT')
                .map(m => m.id); // 例如 BTC-USDT-SWAP

            await this.connectWebSocket(instIds);

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

            // 并发与重试参数
            const CONCURRENCY = 20;         // 单批并发数
            const BATCH_PAUSE_MS = 200;     // 批次间暂停
            const MAX_RETRIES = 2;          // 每个请求最多重试次数

            let successCount = 0;
            let errorCount = 0;
            const reasonCounters = {
                rateLimit: 0,
                serverError: 0,
                emptyData: 0,
                network: 0,
                other: 0
            };

            // 不清空已有成功数据，避免“失败时覆盖为无”
            // 如果希望每轮都重建，可以取消下面注释并删除上面的保留策略
            // this.fundingMap = {};

            for (let i = 0; i < swapSymbols.length; i += CONCURRENCY) {
                const batch = swapSymbols.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (instId) => {
                    try {
                        const item = await this.requestFundingWithRetry(instId, MAX_RETRIES);
                        if (!item) {
                            errorCount++;
                            reasonCounters.emptyData++;
                            if (config.logging.enableDetailedFunding) {
                                logger.fundingError('okx', `Empty funding data for ${instId}`);
                            }
                            return;
                        }

                        const symbol = this.exchange.safeSymbol(item.instId);
                        if (!symbol) {
                            // 正常情况下不太会发生，忽略
                            errorCount++;
                            reasonCounters.other++;
                            if (config.logging.enableDetailedFunding) {
                                logger.fundingError('okx', `safeSymbol failed for ${instId}`);
                            }
                            return;
                        }

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
                                fundingTime,
                                fundingInterval
                            });
                        }
                    } catch (e) {
                        errorCount++;
                        // 归类错误原因
                        const msg = (e && e.message) || '';
                        if (e.isRateLimit || /429/.test(msg) || /Too Many/i.test(msg)) {
                            reasonCounters.rateLimit++;
                        } else if (/5\d\d/.test(msg)) {
                            reasonCounters.serverError++;
                        } else if (/timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
                            reasonCounters.network++;
                        } else {
                            reasonCounters.other++;
                        }

                        if (config.logging.enableDetailedFunding) {
                            logger.fundingError('okx', `Failed to fetch funding rate for ${instId}`, e);
                        }
                    }
                }));

                // 批次间停顿，降低触发频控的概率
                await this.sleep(BATCH_PAUSE_MS);
            }

            logger.fundingSummary('okx', 'Funding rate fetch completed', {
                successCount,
                errorCount,
                totalSymbols: Object.keys(this.fundingMap).length,
                reasons: reasonCounters
            });

        } catch (error) {
            logger.fundingError('okx', 'Error in fetchFundingInfo', error);
        }
    }
    
    getFundingMap() {
        return this.fundingMap;
    }

    async connectWebSocket(instIds) {
        try {
            if (this.ws) {
                this.ws.close();
            }

            const wsUrl = 'wss://ws.okx.com:8443/ws/v5/public';
            const wsOptions = {
                agent: this.proxyAgent,
                handshakeTimeout: 30000,
                perMessageDeflate: false,
                maxPayload: 50 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; OKXWSClient/1.0)'
                }
            };

            this.ws = new WebSocket(wsUrl, wsOptions);

            const connectionTimeout = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    logger.exchangeError('okx', 'WEBSOCKET', 'connection_timeout');
                    this.ws.terminate();
                }
            }, 15000);

            this.ws.on('open', async () => {
                clearTimeout(connectionTimeout);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.lastMessageTime = Date.now();
                logger.websocket('okx', 'connected', 'WebSocket connected successfully');

                // 批量订阅 tickers（OKX 单次最多 100 个 args）
                await this.subscribeTickersInBatches(instIds);

                // 心跳：每 30s 发送 ping 帧
                this.setupPingPong();
            });

            this.ws.on('message', (raw) => {
                try {
                    this.lastMessageTime = Date.now();
                    const msg = JSON.parse(raw.toString());

                    // 错误事件
                    if (msg.event === 'error') {
                        logger.websocket('okx', 'error', `WS error: code=${msg.code}, msg=${msg.msg}`);
                        return;
                    }
                    // 订阅确认
                    if (msg.event === 'subscribe') {
                        return;
                    }
                    // 行情数据
                    if (msg.arg && msg.arg.channel === 'tickers' && Array.isArray(msg.data)) {
                        this.processTickerData(msg.data);
                        return;
                    }
                } catch (e) {
                    logger.websocket('okx', 'error', `Message parse error: ${e.message}`);
                }
            });

            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                this.clearPingPong();
                logger.websocket('okx', 'disconnected', `Closed: ${code} ${reason}`);
                this.handleReconnect(() => this.connectWebSocket(instIds));
            });

            this.ws.on('error', (err) => {
                this.isConnected = false;
                this.clearPingPong();
                logger.websocket('okx', 'error', `WS error: ${err.code || ''} ${err.message}`);
                this.handleReconnect(() => this.connectWebSocket(instIds));
            });
        } catch (err) {
            logger.websocket('okx', 'error', `Connect error: ${err.message}`);
            this.handleReconnect(() => this.connectWebSocket(instIds));
        }
    }

    async subscribeTickersInBatches(instIds) {
        const batchSize = 100;
        let batches = 0;
        for (let i = 0; i < instIds.length; i += batchSize) {
            const batch = instIds.slice(i, i + batchSize);
            const args = batch.map(instId => ({ channel: 'tickers', instId }));
            const payload = { op: 'subscribe', args };
            this.ws.send(JSON.stringify(payload));
            batches++;
        }
        logger.websocket('okx', 'connected', `Subscribed to ${instIds.length} tickers in ${batches} batches`);
    }

    processTickerData(items) {
        let processed = 0;
        for (const item of items) {
            try {
                const instId = item.instId; // 例如 BTC-USDT-SWAP
                const symbol = this.exchange ? this.exchange.safeSymbol(instId) : instId;

                this.tickersMap[symbol] = {
                    symbol,
                    timestamp: item.ts ? parseInt(item.ts) : Date.now(),
                    datetime: new Date(item.ts ? parseInt(item.ts) : Date.now()).toISOString(),
                    high: item.high24h ? parseFloat(item.high24h) : null,
                    low: item.low24h ? parseFloat(item.low24h) : null,
                    bid: item.bidPx ? parseFloat(item.bidPx) : null,
                    bidVolume: item.bidSz ? parseFloat(item.bidSz) : null,
                    ask: item.askPx ? parseFloat(item.askPx) : null,
                    askVolume: item.askSz ? parseFloat(item.askSz) : null,
                    vwap: null,
                    open: item.open24h ? parseFloat(item.open24h) : null,
                    close: item.last ? parseFloat(item.last) : null,
                    last: item.last ? parseFloat(item.last) : null,
                    previousClose: null,
                    change: null,
                    percentage: null,
                    average: null,
                    baseVolume: item.vol24h ? parseFloat(item.vol24h) : null,
                    quoteVolume: item.volCcy24h ? parseFloat(item.volCcy24h) : null,
                    info: item
                };
                processed++;
            } catch (e) {
                logger.exchangeError('okx', 'ticker_processing', 'Failed to process ticker item', e);
            }
        }
        if (config.logging.enableTickerLogs) {
            logger.tickerInfo('okx', `Processed ${processed} tickers via WebSocket`);
        }
    }

    setupPingPong() {
        this.clearPingPong();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.ping();
                } catch (_) {}
            }
        }, 30000);
    }

    clearPingPong() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    handleReconnect(reconnectFn) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.websocket('okx', 'error', 'Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        logger.websocket('okx', 'reconnecting', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(() => reconnectFn(), delay);
    }

    // 用 WS 缓存直接返回 tickers（与 Binance 一致）
    async fetchTickers() {
        if (!this.isConnected) {
            logger.exchangeWarn('okx', null, 'WebSocket not connected, returning cached tickers');
        }
        return this.tickersMap;
    }

    // 新增：将资金费率请求放入类内部，供 fetchFundingInfo 调用
    async requestFundingWithRetry(instId, maxRetries = 2) {
        const url = 'https://www.okx.com/api/v5/public/funding-rate';
        let attempt = 0;

        // 指数退避：300ms, 600ms, 1200ms ...
        const backoff = (n) => 300 * Math.pow(2, n);

        // 最多 maxRetries+1 次尝试
        while (attempt <= maxRetries) {
            try {
                const response = await axios.get(url, {
                    params: { instId },
                    httpsAgent: this.proxyAgent,
                    timeout: 15000
                });

                // OKX 成功 code 为 '0'
                if (response.data && response.data.code === '0' && Array.isArray(response.data.data) && response.data.data.length > 0) {
                    return response.data.data[0];
                }

                // 非成功返回也抛错，进入重试
                const code = response.data?.code;
                const msg = response.data?.msg;
                const err = new Error(`Invalid response for ${instId} (code=${code}, msg=${msg})`);
                // 标记一些常见的频控错误，方便归类
                if (code === '429' || /too many/i.test(msg || '')) {
                    err.isRateLimit = true;
                }
                throw err;
            } catch (e) {
                if (attempt === maxRetries) {
                    // 最终失败，抛出
                    throw e;
                }
                // 指数退避后重试
                const wait = backoff(attempt);
                await this.sleep(wait);
                attempt++;
            }
        }
        return null;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    disconnect() {
        this.clearPingPong();
        if (this.ws) {
            this.ws.close(1000, 'Normal closure');
            this.ws = null;
        }
        this.isConnected = false;
    }
}

module.exports = OKXExchange;