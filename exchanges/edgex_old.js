const axios = require('axios');
const { getProxyAgent } = require('../utils/proxy');
const logger = require('../utils/logger');
const config = require('../config/config');

class EdgexExchangeOld {
    constructor() {
        this.name = 'Edgex';
        this.proxyAgent = getProxyAgent();
        this.baseUrl = process.env.EDGEX_BASE_URL || 'https://pro.edgex.exchange'; // REST 基础域名
        this.contracts = [];               // 合约列表（仅 USDT 永续）
        this.contractIdToSymbol = {};      // contractId -> 'BTC/USDT'
        this.symbolToContractId = {};      // 'BTC/USDT' -> contractId
        this.tickersMap = {};              // 缓存 ticker（与其它交易所接口一致）
        this.fundingMap = {};              // 缓存资金费率
        this.batchSize = Number(process.env.EDGEX_BATCH_SIZE || 10);      // 每批并发数（更保守）
        this.batchPauseMs = Number(process.env.EDGEX_BATCH_PAUSE_MS || 200); // 批次间暂停
        this.maxRetries = Number(process.env.EDGEX_RETRIES || 2);         // 每请求最大重试
        this.requestTimeout = Number(process.env.EDGEX_TIMEOUT_MS || 15000); // 请求超时
        this.quoteCoinName = process.env.EDGEX_QUOTE || 'USDT'; // 依据元数据的报价币过滤
        this.treatUsdAsUsdt = (process.env.EDGEX_TREAT_USD_AS_USDT || 'true').toLowerCase() === 'true';
        this.includeByNameSuffix = (process.env.EDGEX_INCLUDE_BY_NAME_SUFFIX || 'true').toLowerCase() === 'true';
    }

    async initialize() {
        try {
            await this.loadMarkets();
            logger.exchangeInit('edgex', true);
        } catch (e) {
            logger.exchangeInit('edgex', false, e);
            throw e;
        }
    }

    // 从合约名推断 base 的回退方案：同时去掉 USDT 或 USD 后缀
    normalizeBaseFromContractName(name) {
        if (!name) return name;
        return name.replace(/(USDT|USD)$/i, '');
    }

    // 规范化币种代码，尽量从多字段里归一化出 USDT/XXX
    normalizeCoinCode(raw) {
        if (!raw) return '';
        let s = String(raw).toUpperCase().trim();
        // 常见映射：包含 USDT 的都视为 USDT；包含 TETHER 也视为 USDT
        if (s.includes('USDT') || s.includes('TETHER')) return 'USDT';
        // 有些元数据可能给 "USD" 但实际上是 USDT 结算，允许配置视为 USDT
        if (this.treatUsdAsUsdt && (s === 'USD' || s.includes('USD'))) return 'USDT';
        // 其他场景直接返回标准大写
        return s;
    }

    // 当元数据拿不到 quote 时，允许根据合约名后缀兜底
    deriveQuoteFromContractName(name) {
        if (!name) return '';
        return /(USDT|USD)$/i.test(name) ? 'USDT' : '';
    }

    async loadMarkets() {
        // GET /api/v1/public/meta/getMetaData -> contractList/coinList 等元数据
        // 用于建立 contractId <-> symbol 的双向映射
        const url = `${this.baseUrl}/api/v1/public/meta/getMetaData`; // <mcreference link="https://edgex-1.gitbook.io/edgeX-documentation/api/public-api/metadata-api" index="0">0</mcreference>
        const resp = await axios.get(url, {
            httpsAgent: this.proxyAgent,
            timeout: this.requestTimeout,
        });

        const data = resp.data?.data;
        if (!data || !Array.isArray(data.contractList)) {
            throw new Error('Invalid meta data from Edgex');
        }

        // coinId -> 币种代码（优先 symbol/code，再退回到 name），并做规范化
        const coinIdToCode = {};
        if (Array.isArray(data.coinList)) {
            for (const coin of data.coinList) {
                const candidates = [
                    coin?.coinSymbol,
                    coin?.symbol,
                    coin?.coinName,
                    coin?.name,
                    coin?.code
                ].filter(Boolean);
                const norm = this.normalizeCoinCode(candidates[0]);
                if (coin && coin.coinId && norm) {
                    coinIdToCode[String(coin.coinId)] = norm;
                }
            }
        }

        this.contracts = [];
        this.contractIdToSymbol = {};
        this.symbolToContractId = {};

        for (const c of data.contractList) {
            if (!c || !c.contractId || !c.contractName) continue;
            if (c.enableDisplay === false || c.enableTrade === false) continue;

            // 优先从元数据字段推断报价币，失败则根据名称后缀兜底
            let quoteCode = this.normalizeCoinCode(
                c.quoteCoinName || c.quoteCoin || c.quoteCurrency || c.quoteSymbol || coinIdToCode[String(c.quoteCoinId)] || ''
            );
            if (!quoteCode && this.includeByNameSuffix) {
                quoteCode = this.deriveQuoteFromContractName(c.contractName);
            }

            // 只保留 USDT（可配置），无法判断则跳过
            if (this.quoteCoinName && quoteCode !== this.quoteCoinName) continue;

            // base：优先用元数据，否则从合约名剔除后缀
            const baseFromMeta = this.normalizeCoinCode(
                coinIdToCode[String(c.baseCoinId)] || c.baseCoinName || c.baseCoin || ''
            );
            const base = baseFromMeta || this.normalizeBaseFromContractName(c.contractName);

            const symbol = `${base}/${quoteCode}:${quoteCode}`;

            this.contracts.push({
                id: String(c.contractId),
                name: c.contractName,
                symbol,
                base,
                quote: quoteCode,
            });
            this.contractIdToSymbol[String(c.contractId)] = symbol;
            this.symbolToContractId[symbol] = String(c.contractId);
        }

        if (this.contracts.length === 0) {
            const sample = Array.isArray(data.contractList)
                ? data.contractList.slice(0, 5).map(x => ({
                    id: x.contractId,
                    name: x.contractName,
                    baseCoinId: x.baseCoinId,
                    quoteCoinId: x.quoteCoinId,
                    quoteCoinName: x.quoteCoinName || null
                }))
                : [];
            logger.exchangeWarn('edgex', 'INIT', 'No contracts matched filter. Check metadata fields or env flags.', { sample });
        }

        logger.exchangeInfo('edgex', 'INIT', `Loaded ${this.contracts.length} ${this.quoteCoinName} contracts`);
    }

    // 分批辅助
    async forEachInBatches(items, batchSize, fn) {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(fn));
        }
    }

    // 简单 sleep
    sleep(ms) {
        return new Promise((res) => setTimeout(res, ms));
    }

    // 带指数退避与抖动的通用重试
    async requestWithRetry(doRequest, context = '') {
        let attempt = 0;
        while (true) {
            try {
                return await doRequest();
            } catch (e) {
                if (attempt >= this.maxRetries) throw e;
                const base = 300 * Math.pow(2, attempt); // 300, 600, 1200...
                const jitter = Math.floor(Math.random() * 100);
                const delay = base + jitter;
                logger.exchangeWarn('edgex', context || 'REQUEST', `retrying (attempt ${attempt + 1}) after ${delay}ms`, {
                    error: e.message
                });
                await this.sleep(delay);
                attempt++;
            }
        }
    }

    // 分批执行 + 批间暂停
    async forEachInBatches(items, batchSize, fn) {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(fn));
            if (i + batchSize < items.length) {
                await this.sleep(this.batchPauseMs);
            }
        }
    }

    // 拉取 tickers（使用 Quote API 的 getTicker）
    async fetchTickers() {
        const url = `${this.baseUrl}/api/v1/public/quote/getTicker`;

        let success = 0;
        let failed = 0;
        let skipped = 0;

        await this.forEachInBatches(this.contracts, this.batchSize, async (c) => {
            try {
                const r = await this.requestWithRetry(() => axios.get(url, {
                    params: { contractId: c.id },
                    httpsAgent: this.proxyAgent,
                    timeout: this.requestTimeout
                }), 'TICKER');

                const item = Array.isArray(r.data?.data) ? r.data.data[0] : null;
                if (!item) {
                    skipped++;
                    logger.exchangeWarn('edgex', 'TICKER', `empty ticker for ${c.symbol}(${c.id})`);
                    return;
                }

                const ts = Number(item.endTime || item.highTime || item.lowTime || item.startTime || Date.now());
                const last = parseFloat(item.lastPrice);
                const high = parseFloat(item.high);
                const low = parseFloat(item.low);
                const open = parseFloat(item.open);
                const close = parseFloat(item.close);
                const baseVolume = parseFloat(item.size);
                const quoteVolume = parseFloat(item.value);

                this.tickersMap[c.symbol] = {
                    symbol: c.symbol,
                    timestamp: ts,
                    datetime: new Date(ts).toISOString(),
                    high: isFinite(high) ? high : null,
                    low: isFinite(low) ? low : null,
                    bid: null,
                    bidVolume: null,
                    ask: null,
                    askVolume: null,
                    vwap: null,
                    open: isFinite(open) ? open : null,
                    close: isFinite(close) ? close : null,
                    last: isFinite(last) ? last : null,
                    previousClose: null,
                    change: null,
                    percentage: null,
                    average: null,
                    baseVolume: isFinite(baseVolume) ? baseVolume : null,
                    quoteVolume: isFinite(quoteVolume) ? quoteVolume : null,
                    info: {
                        contractId: c.id,
                        indexPrice: item.indexPrice ? String(item.indexPrice) : null,
                        oraclePrice: item.oraclePrice ? String(item.oraclePrice) : null,
                        openInterest: item.openInterest ? String(item.openInterest) : null,
                        fundingRate: item.fundingRate ? String(item.fundingRate) : null,
                        fundingTime: item.fundingTime ? Number(item.fundingTime) : null,
                        nextFundingTime: item.nextFundingTime ? Number(item.nextFundingTime) : null
                    }
                };
                success++;
            } catch (e) {
                failed++;
                const status = e.response?.status;
                const reason =
                    status === 429 ? 'rateLimit' :
                    status >= 500 ? 'server' :
                    e.code === 'ECONNABORTED' ? 'timeout' :
                    'network';
                logger.exchangeError('edgex', 'TICKER', `getTicker failed for ${c.symbol}(${c.id})`, {
                    status,
                    reason,
                    error: e.message
                });
            }
        });

        if (config.logging.enableTickerLogs) {
            logger.tickerInfo('edgex', `Fetched ${success} tickers, failed ${failed}, skipped ${skipped}`);
        }
        return this.tickersMap;
    }

    // 拉取资金费率（使用 Funding API 的 getLatestFundingRate）
    async fetchFundingInfo() {
        const url = `${this.baseUrl}/api/v1/public/funding/getLatestFundingRate`;

        let success = 0;
        let failed = 0;
        let skipped = 0;

        await this.forEachInBatches(this.contracts, this.batchSize, async (c) => {
            try {
                const r = await this.requestWithRetry(() => axios.get(url, {
                    params: { contractId: c.id },
                    httpsAgent: this.proxyAgent,
                    timeout: this.requestTimeout
                }), 'FUNDING');

                const item = Array.isArray(r.data?.data) ? r.data.data[0] : null;
                if (!item) {
                    skipped++;
                    logger.exchangeWarn('edgex', 'FUNDING', `empty funding for ${c.symbol}(${c.id})`);
                    return;
                }

                const time = Number(item.fundingTimestamp || item.fundingTime || 0);

                // 单位归一：如果是秒级，转换为毫秒
                let timeMs = time > 0 ? time : null;
                if (timeMs != null && timeMs < 1e12) {
                    timeMs = timeMs * 1000;
                }

                const intervalMin = item.fundingRateIntervalMin ? Number(item.fundingRateIntervalMin) : null;
                const nextFundingTimeMs = (timeMs != null && intervalMin != null)
                    ? timeMs + intervalMin * 60 * 1000
                    : null;

                this.fundingMap[c.symbol] = {
                    fundingRate: parseFloat(item.fundingRate),
                    // 前端读取的是 fundingTime，这里赋为“下一次费率更新时间（毫秒）”
                    fundingTime: nextFundingTimeMs,
                    forecastFundingRate: item.forecastFundingRate ? parseFloat(item.forecastFundingRate) : null,
                    previousFundingRate: item.previousFundingRate ? parseFloat(item.previousFundingRate) : null,
                    premiumIndex: item.premiumIndex ? parseFloat(item.premiumIndex) : null,
                    avgPremiumIndex: item.avgPremiumIndex ? parseFloat(item.avgPremiumIndex) : null,
                    fundingRateIntervalMin: intervalMin,
                    // 同时补充小时制的间隔，方便前端显示
                    fundingInterval: intervalMin != null ? intervalMin / 60 : null
                };
                success++;
            } catch (e) {
                failed++;
                const status = e.response?.status;
                const reason =
                    status === 429 ? 'rateLimit' :
                    status >= 500 ? 'server' :
                    e.code === 'ECONNABORTED' ? 'timeout' :
                    'network';
                logger.exchangeError('edgex', 'FUNDING', `getLatestFundingRate failed for ${c.symbol}(${c.id})`, {
                    status,
                    reason,
                    error: e.message
                });
            }
        });

        logger.fundingSummary('edgex', 'Funding rate fetch completed', {
            successCount: success,
            errorCount: failed,
            totalSymbols: this.contracts.length
        });
        return this.fundingMap;
    }

    getFundingMap() {
        return this.fundingMap;
    }

    // 为对齐接口，保留空的 WS 断开方法
    disconnect() {
        // 当前使用 REST 轮询，无持久连接
    }
}

module.exports = EdgexExchange;