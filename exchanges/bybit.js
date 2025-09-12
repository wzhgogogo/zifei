const ccxt = require('ccxt');
const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');
const WebSocket = require('ws');

class BybitExchange {
    constructor() {
        this.name = 'Bybit';
        this.exchange = null;
        this.fundingMap = {};
        this.proxyAgent = getProxyAgent();
        this.ws = null;
        this.isConnected = false;
        this.lastMessageTime = 0;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000; // 基础重连延迟
        this.pingTimer = null;
        this.tickersMap = {};
        this.closingForReconnect = false; // 主动关闭旧连接时，阻止 close/error 回调触发重连
        // Bybit 本地错误去重（仅对 ticker 处理汇总）
        this.tickerErrorCache = new Map();
        this.tickerErrorWindowMs = 1000;
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
    
            // 仅订阅 USDT 永续（使用市场 id，如 BTCUSDT）
            const instIds = Object.values(this.exchange.markets)
                .filter(m => m.swap && m.quote === 'USDT')
                .map(m => m.id);
    
            await this.connectWebSocket(instIds);
    
            logger.exchangeInit('bybit', 'Exchange initialized successfully');
        } catch (error) {
            logger.exchangeError('bybit', 'initialization', 'Failed to initialize exchange', error);
            throw error;
        }
    }
    
    async fetchTickers() {
        try {
            if (!this.isConnected) {
                logger.exchangeWarn('bybit', null, 'WebSocket not connected, returning cached tickers');
            }
            return this.tickersMap;
        } catch (error) {
            logger.tickerError('bybit', null, 'Failed to fetch tickers', error);
            return {};
        }
    }
    
    async fetchFundingInfo() {
        try {
            logger.fundingInfo('bybit', 'Starting funding rate fetch');
            
            // 获取交易对信息（用于过滤出 USDT 永续）——新增：分页拉取，避免 limit=1000 漏项
            const allowedSymbols = new Set();
            let cursor = undefined;
            let pageCount = 0;
            while (true) {
                const instrumentsResponse = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
                    params: {
                        category: 'linear',
                        limit: 1000,
                        ...(cursor ? { cursor } : {})
                    },
                    httpsAgent: this.proxyAgent
                });
                const instList = instrumentsResponse.data?.result?.list || [];
                for (const inst of instList) {
                    const contractType = (inst.contractType || '').toString().toLowerCase();
                    const quote = (inst.quoteCoin || '').toString().toUpperCase();
                    const isPerp = contractType.includes('perpetual') || contractType.includes('perp');
                    if (quote === 'USDT' && isPerp) {
                        allowedSymbols.add(inst.symbol);
                    }
                }
                pageCount++;
                const next = instrumentsResponse.data?.result?.nextPageCursor;
                if (!next) break;
                cursor = next;
            }
            if (config.logging.enableDetailedFunding) {
                logger.fundingSuccess('bybit', `Loaded instruments pages=${pageCount}, usdt-perp symbols=${allowedSymbols.size}`);
            }
    
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
                let skippedCount = 0;
                const skippedSamples = []; // 新增：采样被跳过的symbol
    
                for (const item of response.data.result.list) {
                    try {
                        // 仅处理 USDT 永续
                        if (!item?.symbol || !allowedSymbols.has(item.symbol)) {
                            if (skippedSamples.length < 3 && item?.symbol) skippedSamples.push(item.symbol);
                            skippedCount++;
                            continue;
                        }
    
                        const hasFundingRate = item.fundingRate !== undefined && item.fundingRate !== null;
                        const hasNextFundingTime = item.nextFundingTime !== undefined && item.nextFundingTime !== null;
    
                        if (hasFundingRate && hasNextFundingTime) {
                            // 使用 ccxt 安全映射，指定 'swap' 消歧
                            let symbol;
                            try {
                                symbol = this.exchange
                                    ? this.exchange.safeSymbol(item.symbol, undefined, undefined, 'swap')
                                    : item.symbol.replace('USDT', '/USDT:USDT');
                            } catch {
                                symbol = item.symbol.replace('USDT', '/USDT:USDT');
                            }
    
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
                        logger.fundingError('bybit', `Failed to process funding data for ${item?.symbol || 'unknown'}`, itemError);
                    }
                }
    
                // 未开启详细日志时，输出简要汇总 + 样例，便于观察
                if (!config.logging.enableDetailedFunding) {
                    const samplePairs = Object.entries(this.fundingMap)
                        .slice(0, 3)
                        .map(([sym, v]) => `${sym}=${v.fundingRate}`)
                        .join(', ');
                    const extraOk = samplePairs ? `, samples: ${samplePairs}` : '';
                    const extraSkip = skippedSamples.length > 0 ? `, skippedSamples: ${skippedSamples.join(', ')}` : '';
                    logger.fundingSuccess('bybit', `Funding rate details: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped${extraOk}${extraSkip}`);
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

    async connectWebSocket(instIds) {
        try {
            if (this.ws) {
                // 主动关闭旧连接，设置标记，避免旧连接的 close/error 回调触发重连
                this.closingForReconnect = true;
                try { this.ws.close(); } catch (_) {}
            }
    
            // Bybit 线性合约公共流（USDT/USDC 永续 & USDT 期货）
            const wsUrl = 'wss://stream.bybit.com/v5/public/linear'; // 订阅格式: tickers.SYMBOL
            const wsOptions = {
                agent: this.proxyAgent,
                handshakeTimeout: 30000,
                perMessageDeflate: false,
                maxPayload: 50 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; BybitWSClient/1.0)'
                }
            };
    
            this.ws = new WebSocket(wsUrl, wsOptions);
    
            const openTimer = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    logger.websocket('bybit', 'error', 'connection_timeout');
                    this.ws.terminate();
                }
            }, 15000);
    
            this.ws.on('open', async () => {
                clearTimeout(openTimer);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.lastMessageTime = Date.now();
                // 新连接已建立，重置主动关闭标记
                this.closingForReconnect = false;
                logger.websocket('bybit', 'connected', 'WebSocket connected successfully');
    
                await this.subscribeTickersInBatches(instIds);
                this.setupPingPong(); // 心跳
            });
    
            this.ws.on('message', (raw) => {
                try {
                    this.lastMessageTime = Date.now();
                    const msg = JSON.parse(raw.toString());
    
                    // 订阅确认/心跳回复不逐条打印
                    if (msg.op === 'subscribe' || msg.ret_msg === 'pong') return;
    
                    // 行情数据：topic: tickers.SYMBOL
                    if (msg.topic && typeof msg.topic === 'string' && msg.topic.startsWith('tickers.')) {
                        const items = Array.isArray(msg.data) ? msg.data : (msg.data ? [msg.data] : []);
                        if (items.length > 0) {
                            this.processTickerData(items);
                        }
                        return;
                    }
                } catch (e) {
                    logger.websocket('bybit', 'error', `Message parse error: ${e.message}`);
                }
            });
    
            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                this.clearPingPong();
                logger.websocket('bybit', 'disconnected', `Closed: ${code} ${reason || ''}`);
                // 如果是我们主动切换连接导致的关闭，则不重连
                if (this.closingForReconnect) {
                    this.closingForReconnect = false;
                    return;
                }
                this.handleReconnect(() => this.connectWebSocket(instIds));
            });
    
            this.ws.on('error', (err) => {
                this.isConnected = false;
                this.clearPingPong();
                logger.websocket('bybit', 'error', `WS error: ${err.code || ''} ${err.message}`);
                // 主动关闭阶段产生的错误也跳过重连
                if (this.closingForReconnect) {
                    return;
                }
                this.handleReconnect(() => this.connectWebSocket(instIds));
            });
        } catch (err) {
            logger.websocket('bybit', 'error', `Connect error: ${err.message}`);
            this.handleReconnect(() => this.connectWebSocket(instIds));
        }
    }

    async subscribeTickersInBatches(instIds) {
        const batchSize = 100; // 保守分批，避免 args 过长
        let batches = 0;
        for (let i = 0; i < instIds.length; i += batchSize) {
            const batch = instIds.slice(i, i + batchSize);
            const args = batch.map(id => `tickers.${id}`);
            const payload = { op: 'subscribe', args };
            this.ws.send(JSON.stringify(payload));
            batches++;
        }
        logger.websocket('bybit', 'connected', `Subscribed to ${instIds.length} tickers in ${batches} batches`);
    }

    processTickerData(items) {
        let processed = 0;
        let failed = 0;
        let firstError = null; // { symbol, error, item }
        const samples = []; // 新增：收集少量样例，显示在日志里

        for (const item of items) {
            // 先做快速校验，缺少 symbol 的直接跳过，避免进入 try/catch 产生错误日志风暴
            if (!item || !item.symbol) {
                continue;
            }
            try {
                // Bybit v5 ticker 字段
                const marketId = item.symbol; // 例如 BTCUSDT
                const symbol = this.exchange
                    // 关键修复：传入第4个参数 'swap'，消歧合约与现货
                    ? this.exchange.safeSymbol(marketId, undefined, undefined, 'swap')
                    : marketId.replace('USDT', '/USDT:USDT');

                this.tickersMap[symbol] = {
                    symbol,
                    timestamp: item.ts ? parseInt(item.ts) : Date.now(),
                    datetime: new Date(item.ts ? parseInt(item.ts) : Date.now()).toISOString(),
                    high: item.highPrice24h ? parseFloat(item.highPrice24h) : null,
                    low: item.lowPrice24h ? parseFloat(item.lowPrice24h) : null,
                    bid: item.bid1Price ? parseFloat(item.bid1Price) : null,
                    bidVolume: item.bid1Size ? parseFloat(item.bid1Size) : null,
                    ask: item.ask1Price ? parseFloat(item.ask1Price) : null,
                    askVolume: item.ask1Size ? parseFloat(item.ask1Size) : null,
                    vwap: null,
                    open: item.prevPrice24h ? parseFloat(item.prevPrice24h) : null,
                    close: item.lastPrice ? parseFloat(item.lastPrice) : null,
                    last: item.lastPrice ? parseFloat(item.lastPrice) : null,
                    previousClose: null,
                    change: null,
                    percentage: item.price24hPcnt ? parseFloat(item.price24hPcnt) * 100 : null, // 转为百分比
                    average: null,
                    baseVolume: item.volume24h ? parseFloat(item.volume24h) : null,
                    quoteVolume: item.turnover24h ? parseFloat(item.turnover24h) : null,
                    info: item
                };
                processed++;
                // 新增：收集最多3个样例 symbol=last
                if (samples.length < 3 && item.lastPrice) {
                    samples.push(`${symbol}=${parseFloat(item.lastPrice)}`);
                }
            } catch (e) {
                failed++;
                if (!firstError) {
                    firstError = { symbol: item?.symbol || 'unknown', error: e, item };
                }
                // 不再逐条打印，改为在批量结束后汇总
            }
        }

        // 仅在出现失败时打印一条汇总错误，并做 1 秒去重
        if (failed > 0 && firstError) {
            const key = 'ticker_processing_batch';
            const now = Date.now();
            const entry = this.tickerErrorCache.get(key) || { last: 0 };
            if (now - entry.last >= this.tickerErrorWindowMs) {
                entry.last = now;
                this.tickerErrorCache.set(key, entry);

                const sampleText = (() => {
                    try {
                        const raw = JSON.stringify(firstError.item);
                        return raw.length > 500 ? raw.slice(0, 500) + '... (truncated)' : raw;
                    } catch {
                        return '[unserializable item]';
                    }
                })();

                const errorMsg = `ticker_processing: failed ${failed}/${items.length}. symbol=${firstError.symbol}, error=${firstError.error.message}. item=${sampleText}`;
                logger.exchangeError('bybit', 'TICKER', errorMsg, firstError.error);
            }
        }

        if (config.logging.enableTickerLogs) {
            // 修正签名：logger.tickerInfo(exchange, message, data?)
            const sampleText = samples.length > 0 ? `, samples: ${samples.join(', ')}` : '';
            const failText = failed > 0 ? `, failed ${failed}` : '';
            logger.tickerInfo('bybit', `Processed ${processed}/${items.length} tickers via WebSocket${failText}${sampleText}`);
        }
    }

    setupPingPong() {
        this.clearPingPong();
        // Bybit 建议每 20s 发送 {"op":"ping"} 维持连接
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ op: 'ping' }));
                } catch (_) {}
            }
        }, 20000);
    }

    clearPingPong() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    handleReconnect(reconnectFn) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.websocket('bybit', 'error', 'Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        logger.websocket('bybit', 'reconnecting', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(() => reconnectFn(), delay);
    }
}

module.exports = BybitExchange;