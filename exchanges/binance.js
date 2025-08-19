const WebSocket = require('ws');
const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class BinanceExchange {
    constructor() {
        this.name = 'Binance';
        this.fundingMap = {};
        this.tickersMap = {}; // WebSocket ticker数据缓存
        this.proxyAgent = getProxyAgent();
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this.isConnected = false;
        this.markets = null;
        this.pingInterval = null;

        // Enhanced error handling properties
        this.lastMessageTime = null;
        this.connectionHealthInterval = null;
        this.messageTimeout = 30000; // 30 seconds without message = unhealthy
        this.connectionStartTime = null;
        this.totalReconnects = 0;
        this.lastErrorType = null;
        this.consecutiveErrors = 0;
    }

    async initialize() {
        try {
            // 获取交易对信息
            const exchangeInfo = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', {
                httpsAgent: this.proxyAgent
            });

            // 构建市场映射
            this.markets = {};
            for (const symbol of exchangeInfo.data.symbols) {
                if (symbol.status === 'TRADING') {
                    const ccxtSymbol = symbol.symbol.replace('USDT', '/USDT:USDT');
                    this.markets[ccxtSymbol] = {
                        id: symbol.symbol,
                        symbol: ccxtSymbol,
                        base: symbol.baseAsset,
                        quote: symbol.quoteAsset,
                        active: symbol.status === 'TRADING'
                    };
                }
            }

            // 启动WebSocket连接
            await this.connectWebSocket();

            logger.exchangeInit('binance', true, `Exchange initialized successfully with ${Object.keys(this.markets).length} active symbols`);
        } catch (error) {
            logger.exchangeError('binance', false, 'initialization', 'Failed to initialize exchange', error);
            throw error;
        }
    }

    async connectWebSocket() {
        try {
            if (this.ws) {
                this.ws.close();
            }

            this.connectionStartTime = Date.now();
            const wsUrl = 'wss://fstream.binance.com/stream?streams=!ticker@arr';

            // 优化连接选项
            const wsOptions = {
                //agent: this.proxyAgent,
                handshakeTimeout: 30000,  // 30秒握手超时
                perMessageDeflate: false, // 禁用压缩以减少CPU负载
                maxPayload: 100 * 1024 * 1024, // 100MB最大负载
                followRedirects: true,
                maxRedirects: 3,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; BinanceWSClient/1.0)',
                    'Accept-Encoding': 'gzip, deflate',
                    'Cache-Control': 'no-cache'
                }
            };

            this.ws = new WebSocket(wsUrl, wsOptions);

            // 设置连接超时
            const connectionTimeout = setTimeout(() => {
                if (this.ws.readyState === WebSocket.CONNECTING) {
                    logger.exchangeError('binance', null, 'connection_timeout', 'WebSocket connection timeout');
                    this.ws.terminate();
                }
            }, 15000); // 15秒连接超时

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.consecutiveErrors = 0;
                this.lastErrorType = null;
                this.lastMessageTime = Date.now();

                logger.exchangeInfo('binance', null, `WebSocket connected successfully (total reconnects: ${this.totalReconnects})`);

                // 设置ping/pong处理和健康检查
                //this.setupPingPong();
                //this.startConnectionHealthMonitoring();
            });

            this.ws.on('message', (data) => {
                try {
                    this.lastMessageTime = Date.now();
                    this.consecutiveErrors = 0;

                    const message = JSON.parse(data.toString());

                    // 处理ticker数组流数据
                    if (message.stream === '!ticker@arr' && Array.isArray(message.data)) {
                        this.processTickers(message.data);
                    } else if (Array.isArray(message)) {
                        // 兼容直接数组格式
                        this.processTickers(message);
                    } else {
                        logger.exchangeError('binance', null, 'message_format', `Unexpected message format: ${JSON.stringify(message).substring(0, 200)}`);
                    }
                } catch (error) {
                    this.handleProcessingError('message_parsing', error);
                }
            });

            this.ws.on('ping', (data) => {
                this.lastMessageTime = Date.now();
                this.ws.pong(data);
            });

            this.ws.on('pong', () => {
                this.lastMessageTime = Date.now();
            });

            this.ws.on('close', (code, reason) => {
                this.handleConnectionClose(code, reason.toString());
            });

            this.ws.on('error', (error) => {
                this.handleConnectionError(error);
            });

        } catch (error) {
            this.handleConnectionError(error, 'connection_setup');
            throw error;
        }
    }

    setupPingPong() {
        this.clearPingInterval();
        // 根据Binance文档，服务器每3分钟发送ping，我们也可以主动发送
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 60000); // 每分钟发送一次ping保持连接
    }

    startConnectionHealthMonitoring() {
        this.clearHealthMonitoring();

        this.connectionHealthInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 15000); // 每15秒检查一次连接健康状态
    }

    checkConnectionHealth() {
        const now = Date.now();

        // 检查是否长时间没有收到消息
        if (this.lastMessageTime && (now - this.lastMessageTime) > this.messageTimeout) {
            logger.exchangeError('binance', null, 'health_check',
                `No messages received for ${Math.round((now - this.lastMessageTime) / 1000)}s, connection may be stale`);

            // 强制重连
            this.forceReconnect('stale_connection');
            return;
        }

        // 检查WebSocket状态
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            logger.exchangeError('binance', null, 'health_check',
                `WebSocket in invalid state: ${this.ws.readyState}`);
            this.forceReconnect('invalid_state');
            return;
        }

        // 连接健康
        if (config.logging.enableDetailedLogs) {
            const uptime = Math.round((now - this.connectionStartTime) / 1000);
            logger.exchangeInfo('binance', null,
                `Connection healthy - uptime: ${uptime}s, cached tickers: ${Object.keys(this.tickersMap).length}`);
        }
    }

    handleConnectionClose(code, reason) {
        this.isConnected = false;
        this.clearPingInterval();
        this.clearHealthMonitoring();

        // 分类关闭原因
        let closeType = 'unknown';
        if (code === 1000) closeType = 'normal';
        else if (code === 1001) closeType = 'going_away';
        else if (code === 1002) closeType = 'protocol_error';
        else if (code === 1003) closeType = 'unsupported_data';
        else if (code === 1006) closeType = 'abnormal_closure';
        else if (code === 1011) closeType = 'server_error';

        logger.exchangeError('binance', null, 'websocket',
            `WebSocket closed: ${code} (${closeType}) - ${reason}`);

        // 根据关闭类型决定重连策略
        if (code !== 1000) { // 非正常关闭才重连
            this.handleReconnect(closeType);
        }
    }

    handleConnectionError(error, errorType = 'connection') {
        this.isConnected = false;
        this.clearPingInterval();
        this.clearHealthMonitoring();
        this.consecutiveErrors++;
        this.lastErrorType = errorType;

        // 错误分类和日志
        let errorCategory = 'unknown';
        if (error.code === 'ECONNREFUSED') errorCategory = 'connection_refused';
        else if (error.code === 'ENOTFOUND') errorCategory = 'dns_error';
        else if (error.code === 'ETIMEDOUT') errorCategory = 'timeout';
        else if (error.code === 'ECONNRESET') errorCategory = 'connection_reset';

        logger.exchangeError('binance', null, 'websocket',
            `WebSocket error (${errorCategory}): ${error.message} [consecutive: ${this.consecutiveErrors}]`, error);

        this.handleReconnect(errorCategory);
    }

    handleProcessingError(errorType, error) {
        this.consecutiveErrors++;

        logger.exchangeError('binance', null, errorType,
            `Processing error [consecutive: ${this.consecutiveErrors}]: ${error.message}`, error);

        // 如果连续处理错误过多，考虑重连
        if (this.consecutiveErrors >= 10) {
            logger.exchangeError('binance', null, 'processing',
                `Too many consecutive processing errors (${this.consecutiveErrors}), forcing reconnect`);
            this.forceReconnect('processing_errors');
        }
    }

    forceReconnect(reason) {
        logger.exchangeInfo('binance', null, `Forcing reconnection due to: ${reason}`);

        if (this.ws) {
            this.ws.close();
        }

        // 立即尝试重连
        setTimeout(() => {
            this.handleReconnect(reason);
        }, 1000);
    }

    handleReconnect(errorType = 'unknown') {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.exchangeError('binance', null, 'websocket',
                `Max reconnection attempts reached (${this.maxReconnectAttempts}). Last error: ${errorType}`);
            return;
        }

        this.reconnectAttempts++;
        this.totalReconnects++;

        // 根据错误类型调整重连延迟
        let delay = this.reconnectDelay * this.reconnectAttempts;

        // 对于某些错误类型使用不同的重连策略
        if (errorType === 'dns_error' || errorType === 'connection_refused') {
            delay = Math.min(delay * 2, 60000); // 网络问题时延迟更长
        } else if (errorType === 'server_error') {
            delay = Math.min(delay * 1.5, 30000); // 服务器错误时适中延迟
        }

        logger.exchangeInfo('binance', null,
            `Attempting to reconnect WebSocket in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}, reason: ${errorType})`);

        setTimeout(() => {
            this.connectWebSocket().catch(error => {
                logger.exchangeError('binance', null, 'websocket', 'Reconnection failed', error);
            });
        }, delay);
    }

    clearPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    clearHealthMonitoring() {
        if (this.connectionHealthInterval) {
            clearInterval(this.connectionHealthInterval);
            this.connectionHealthInterval = null;
        }
    }

    processTickers(tickers) {
        let processedCount = 0;

        for (const ticker of tickers) {
            try {
                const symbol = ticker.s.replace('USDT', '/USDT:USDT');

                // 只处理我们支持的交易对
                if (this.markets[symbol]) {
                    // 转换为ccxt格式的ticker数据
                    this.tickersMap[symbol] = {
                        symbol: symbol,
                        timestamp: ticker.E, // Event time
                        datetime: new Date(ticker.E).toISOString(),
                        high: parseFloat(ticker.h), // High price
                        low: parseFloat(ticker.l), // Low price
                        bid: parseFloat(ticker.b) || null, // Best bid price
                        bidVolume: parseFloat(ticker.B) || null, // Best bid quantity
                        ask: parseFloat(ticker.a) || null, // Best ask price
                        askVolume: parseFloat(ticker.A) || null, // Best ask quantity
                        vwap: parseFloat(ticker.w) || null, // Weighted average price
                        open: parseFloat(ticker.o), // Open price
                        close: parseFloat(ticker.c), // Close price (last price)
                        last: parseFloat(ticker.c), // Last price
                        previousClose: null,
                        change: parseFloat(ticker.p), // Price change
                        percentage: parseFloat(ticker.P), // Price change percent
                        average: null,
                        baseVolume: parseFloat(ticker.v), // Total traded base asset volume
                        quoteVolume: parseFloat(ticker.q), // Total traded quote asset volume
                        info: ticker // 保留原始数据
                    };
                    processedCount++;
                }
            } catch (error) {
                logger.exchangeError('binance', null, 'ticker_processing', `Failed to process ticker for ${ticker.s}`, error);
            }
        }

        if (config.logging.enableTickerLogs) {
            logger.tickerSuccess('binance', null, `Processed ${processedCount} tickers via WebSocket`);
        }
    }

    async fetchTickers() {
        try {
            if (!this.isConnected) {
                logger.exchangeError('binance', null, 'ticker_fetch',
                    `WebSocket not connected (reconnects: ${this.totalReconnects}), returning cached data`);
            }

            // 检查缓存数据的新鲜度
            const cacheAge = this.lastMessageTime ? Date.now() - this.lastMessageTime : Infinity;
            if (cacheAge > 60000) { // 数据超过1分钟
                logger.exchangeError('binance', null, 'ticker_fetch',
                    `Cached data is stale (${Math.round(cacheAge / 1000)}s old)`);
            }

            if (config.logging.enableTickerLogs) {
                logger.tickerSuccess('binance', null,
                    `Returning ${Object.keys(this.tickersMap).length} cached tickers from WebSocket (age: ${Math.round(cacheAge / 1000)}s)`);
            }

            return this.tickersMap;
        } catch (error) {
            logger.tickerError('binance', null, 'Failed to fetch tickers', error);
            return {};
        }
    }

    async fetchFundingInfo() {
        try {
            logger.fundingInfo('binance', null, 'Starting funding rate fetch');

            // 获取资金费率数据
            const fundingResponse = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
                httpsAgent: this.proxyAgent
            });

            // 获取资金费率间隔数据
            const fundingInfoResponse = await axios.get('https://fapi.binance.com/fapi/v1/fundingInfo', {
                httpsAgent: this.proxyAgent
            });

            // 处理资金费率数据
            this.fundingMap = {};
            let successCount = 0;
            let errorCount = 0;

            for (const item of fundingResponse.data) {
                try {
                    const symbol = item.symbol.replace('USDT', '/USDT:USDT');

                    // 查找对应的fundingInterval
                    const fundingInfo = fundingInfoResponse.data.find(info => info.symbol === item.symbol);
                    const fundingInterval = fundingInfo ? parseInt(fundingInfo.fundingIntervalHours) : 8;

                    this.fundingMap[symbol] = {
                        fundingRate: parseFloat(item.lastFundingRate),
                        fundingTime: item.nextFundingTime,
                        fundingInterval: fundingInterval
                    };

                    successCount++;

                    if (config.logging.enableDetailedFunding) {
                        logger.fundingSuccess('binance', null, `${item.symbol} -> ${symbol}`, {
                            fundingRate: item.lastFundingRate,
                            nextFundingTime: item.nextFundingTime,
                            fundingInterval
                        });
                    }
                } catch (itemError) {
                    errorCount++;
                    logger.fundingError('binance', null, `Failed to process funding data for ${item.symbol}`, itemError);
                }
            }

            logger.fundingSummary('binance', null, 'Funding rate fetch completed', {
                successCount,
                errorCount,
                totalSymbols: Object.keys(this.fundingMap).length,
                totalReceived: fundingResponse.data.length
            });

        } catch (error) {
            logger.fundingError('binance', null, 'Error fetching funding rates', error);
        }
    }

    getFundingMap() {
        return this.fundingMap;
    }

    // 清理资源
    disconnect() {
        this.clearPingInterval();
        this.clearHealthMonitoring();

        if (this.ws) {
            this.ws.close(1000, 'Normal closure'); // 正常关闭
            this.ws = null;
        }

        this.isConnected = false;
        logger.exchangeInfo('binance', null,
            `WebSocket disconnected (total uptime reconnects: ${this.totalReconnects})`);
    }

    // 获取连接状态信息
    getConnectionStatus() {
        return {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            totalReconnects: this.totalReconnects,
            lastMessageTime: this.lastMessageTime,
            connectionUptime: this.connectionStartTime ? Date.now() - this.connectionStartTime : 0,
            cachedTickers: Object.keys(this.tickersMap).length,
            lastErrorType: this.lastErrorType,
            consecutiveErrors: this.consecutiveErrors
        };
    }
}

module.exports = BinanceExchange;