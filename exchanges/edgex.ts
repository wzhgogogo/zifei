import axios from 'axios';
import { getProxyAgent } from '../utils/proxy.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import * as querystring from 'querystring';
import WebSocket from 'ws'


interface ContractInfo {
    id: string;                 // 合约ID
    name: string;               // 合约名称，例如 BTCUSDT
    symbol: string;             // 交易对符号，例如 BTC/USDT:USDT
    base: string;               // 基础币种，例如 BTC
    quote: string;              // 计价币种，例如 USDT
    tickSize: number;           // 价格最小变动单位
    stepSize: number;           // 数量最小变动单位
    minOrderSize: number;       // 最小下单量
    maxOrderSize: number;       // 最大下单量
    maxPositionSize?: number;   // 最大持仓量，可选
    defaultMakerFeeRate?: number; // 默认maker手续费率，可选
    defaultTakerFeeRate?: number; // 默认taker手续费率，可选
    fundingRateIntervalMin?: number; // Funding费率间隔分钟，可选
}


interface FundingInfo {
    symbol: string;
    fundingRate: number | null;
    fundingTime: number | null;
    forecastFundingRate?: number | null;
    fundingRateIntervalMin?: number | null;
}


interface TickerInfo {
    contractId?: string;
    symbol: string;
    lastPrice: number | null;
    high: number | null;
    low: number | null;
    open: number | null;
    close: number | null;
    priceChange: number | null;
    priceChangePercent: number | null;
    trades: number | null;
    size: number | null;
    value: number | null;
    highTime: number | null;
    lowTime: number | null;
    startTime: number | null;
    endTime: number | null;
    bidPrice?: number | null;
    bidSize?: number | null;
    askPrice?: number | null;
    askSize?: number | null;
    spread?: number | null;
    timestamp?: number;
    bid: [number, number][];
    ask: [number, number][];
    info?: Record<string, any>; // 保留兜底
}


export class EdgexExchange {
    name: string;
    proxyAgent: any;
    baseUrl: string;

    contracts: Record<string, ContractInfo> = {};
    contractIdToSymbol: Record<string, string> = {};
    symbolToContractId: Record<string, string> = {};
    tickersMap: Record<string, TickerInfo> = {};
    fundingMap: Record<string, FundingInfo> = {};

    batchSize: number;
    batchPauseMs: number;
    maxRetries: number;
    requestTimeout: number;
    quoteCoinName: string;
    treatUsdAsUsdt: boolean;
    includeByNameSuffix: boolean;

    ws?: WebSocket;

    constructor() {
        this.name = 'Edgex';
        this.proxyAgent = getProxyAgent();
        this.baseUrl = process.env.EDGEX_BASE_URL || 'https://pro.edgex.exchange';
        this.batchSize = Number(process.env.EDGEX_BATCH_SIZE || 10);
        this.batchPauseMs = Number(process.env.EDGEX_BATCH_PAUSE_MS || 200);
        this.maxRetries = Number(process.env.EDGEX_RETRIES || 2);
        this.requestTimeout = Number(process.env.EDGEX_TIMEOUT_MS || 15000);
        this.quoteCoinName = process.env.EDGEX_QUOTE || 'USDT';
        this.treatUsdAsUsdt = (process.env.EDGEX_TREAT_USD_AS_USDT || 'true').toLowerCase() === 'true';
        this.includeByNameSuffix = (process.env.EDGEX_INCLUDE_BY_NAME_SUFFIX || 'true').toLowerCase() === 'true';
    }


    async initialize(): Promise<void> {
        try {
            await this.loadMarkets();
            this.fetchTickersAndDepths();
            logger.exchangeInit('edgex', true);
        } catch (e) {
            // @ts-ignore
            logger.exchangeInit('edgex', false, e);
            throw e;
        }
    }

    // 从合约名推断 base 的回退方案：同时去掉 USDT 或 USD 后缀
    normalizeBaseFromContractName(name: string | null | undefined): string {
        if (!name) return '';
        return name.replace(/(USDT|USD)$/i, '');
    }

    // 规范化币种代码，尽量从多字段里归一化出 USDT/XXX
    normalizeCoinCode(raw: string | null | undefined): string {
        if (!raw) return '';
        const s = String(raw).toUpperCase().trim();
        if (s.includes('USDT') || s.includes('TETHER')) return 'USDT';
        if (this.treatUsdAsUsdt && (s === 'USD' || s.includes('USD'))) return 'USDT';
        return s;
    }

    // 当元数据拿不到 quote 时，允许根据合约名后缀兜底
    deriveQuoteFromContractName(name: string | null | undefined): string {
        if (!name) return '';
        return /(USDT|USD)$/i.test(name) ? 'USDT' : '';
    }


    async loadMarkets(): Promise<void> {
        // GET /api/v1/public/meta/getMetaData -> contractList/coinList 等元数据
        const url = `${this.baseUrl}/api/v1/public/meta/getMetaData`;

        // 请求元数据（合约列表 + 币种列表）
        const resp = await axios.get<{ data: { contractList: any[]; coinList?: any[] } }>(url, {
            httpsAgent: this.proxyAgent,
            timeout: this.requestTimeout,
        });

        // 提取返回数据
        const data = resp.data?.data;
        if (!data || !Array.isArray(data.contractList)) {
            throw new Error('Invalid meta data from Edgex');
        }

        // 从Meta Data里取coinID和coinName
        const coinIdToSymbol: Record<string, string> = {};
        if (Array.isArray(data.coinList)) {
            for (const coin of data.coinList) {
                // 先判断 contract 是否存在
                if (coin && coin.coinId && coin.coinName) {
                    // 如果 coin 有 contracId 和 contractName，就存进去
                    const id = String(coin.coinId);   // 比如 "1001"
                    const code = coin.coinName;
                    coinIdToSymbol[id] = code;
                }
            }
        }

        // 清空旧数据（每次重新加载）
        this.contracts = {};
        this.contractIdToSymbol = {};
        this.symbolToContractId = {};

        // 遍历合约列表，组装最终交易对
        for (const c of data.contractList) {
            if (!c || !c.contractId || !c.contractName) continue;

            const base = coinIdToSymbol[String(c.baseCoinId)] || '';
            const quote = coinIdToSymbol[String(c.quoteCoinId)] || '';
            if (!base || !quote) {
                logger.warn?.(`Edgex loadMarkets: missing base/quote for contractId=${c.contractId}`);
                continue;
            }

            const cInfo: ContractInfo = {
                id: String(c.contractId),
                name: String(c.contractName),
                symbol: `${base}/${quote}:${quote}`,
                base,
                quote,
                tickSize: Number(c.tickSize ?? 0),
                stepSize: Number(c.stepSize ?? 0),
                minOrderSize: Number(c.minOrderSize ?? 0),
                maxOrderSize: Number(c.maxOrderSize ?? 0),
                maxPositionSize: c.maxPositionSize != null ? Number(c.maxPositionSize) : undefined,
                defaultMakerFeeRate: c.defaultMakerFeeRate != null ? Number(c.defaultMakerFeeRate) : undefined,
                defaultTakerFeeRate: c.defaultTakerFeeRate != null ? Number(c.defaultTakerFeeRate) : undefined,
                fundingRateIntervalMin: c.fundingRateIntervalMin != null ? Number(c.fundingRateIntervalMin) : undefined,
            };

            this.contracts[cInfo.id] = cInfo;
            this.contractIdToSymbol[cInfo.id] = cInfo.symbol;
            this.symbolToContractId[cInfo.symbol] = cInfo.id;
        }
    }



    // 简单 sleep
    sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 带指数退避与抖动的通用重试
    async requestWithRetry<T>(doRequest: () => Promise<T>, context: string = ''): Promise<T> {
        let attempt = 0;
        while (true) {
            try {
                return await doRequest();
            } catch (e: any) {
                if (attempt >= this.maxRetries) throw e;
                const base = 300 * Math.pow(2, attempt); // 300, 600, 1200...
                const jitter = Math.floor(Math.random() * 100);
                const delay = base + jitter;
                // @ts-ignore
                logger.exchangeWarn('edgex', context || 'REQUEST', `retrying (attempt ${attempt + 1}) after ${delay}ms`, {
                    error: e.message
                });
                await this.sleep(delay);
                attempt++;
            }
        }
    }


    // 分批执行 + 批间暂停
    async forEachInBatches<T>(items: T[], batchSize: number, fn: (item: T) => Promise<any>): Promise<void> {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(fn));
            if (i + batchSize < items.length) {
                await this.sleep(this.batchPauseMs);
            }
        }
    }


    // 订阅全市场的 tickers+depth（使用 Public WebSocket API）
    async fetchTickersAndDepths(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`wss://quote.edgex.exchange/api/v1/public/ws`, {
                agent: this.proxyAgent,
            });

            this.ws.on('open', () => {
                console.log(`[${this.name}] WebSocket connected`);

                // 订阅全市场 ticker
                this.ws?.send(JSON.stringify({
                    type: 'subscribe',
                    channel: 'ticker.all'
                }));

                // 为所有合约订阅 depth.15
                for (const contractId of Object.keys(this.contracts)) {
                    this.ws?.send(JSON.stringify({
                        type: 'subscribe',
                        channel: `depth.${contractId}.15`
                    }));
                }

                resolve();
            });

            this.ws.on('message', (raw: string) => {
                const msg = JSON.parse(raw);

                if (msg.type === 'ping') {
                    // 必须回复 pong，否则服务器会断开连接
                    if (this.ws) {
                        this.ws.send(JSON.stringify({ type: 'pong', time: msg.time }));
                    }
                    return; // 直接返回，不继续往下走
                }

                if (msg.type === 'quote-event' && msg.channel?.startsWith('ticker.')) {
                    this.handleTickerUpdate(msg);
                } else if (msg.type === 'quote-event' && msg.channel?.startsWith('depth.')) {
                    this.handleDepthUpdate(msg);
                }
            });
            // @ts-ignore
            this.ws.on('error', (err) => {
                console.error(`[${this.name}] WS error:`, err);
                reject(err);
            });

            this.ws.on('close', () => {
                console.log(`[${this.name}] WebSocket closed`);
            });
        });
    }

    private handleTickerUpdate(msg: any) {
        const dataArr = msg.content?.data;
        if (!Array.isArray(dataArr)) return;

        for (const data of dataArr) {
            const contractId = data.contractId;
            const symbol = this.contractIdToSymbol[contractId] || contractId;
            const lastPrice = parseFloat(data.lastPrice);
            // @ts-ignore
            this.tickersMap[symbol] = {
                ...(this.tickersMap[symbol] || {}),
                contractId,
                symbol,
                lastPrice,
                timestamp: Date.now(),
            };
        }
    }

    private handleDepthUpdate(msg: any) {
        const dataArr = msg.content?.data;
        if (!Array.isArray(dataArr)) return;

        for (const snapshot of dataArr) {
            const contractId = snapshot.contractId;
            const symbol = this.contractIdToSymbol[contractId] || contractId;

            const bids = snapshot.bids || [];
            const asks = snapshot.asks || [];

            const bestBid = bids.length > 0 ? [parseFloat(bids[0][0]), parseFloat(bids[0][1])] : [undefined, undefined];
            const bestAsk = asks.length > 0 ? [parseFloat(asks[0][0]), parseFloat(asks[0][1])] : [undefined, undefined];

            const spread = (bestBid[0] !== undefined && bestAsk[0] !== undefined)
                ? bestAsk[0] - bestBid[0]
                : undefined;

            if (!this.tickersMap[symbol]) {
                this.tickersMap[symbol] = {
                    ...
                    contractId,
                    symbol,
                    lastPrice: NaN,
                    timestamp: Date.now(),
                };
            }

            this.tickersMap[symbol] = {
                ...this.tickersMap[symbol],
                bidPrice: bestBid[0],
                bidSize: bestBid[1],
                askPrice: bestAsk[0],
                askSize: bestAsk[1],
                spread,
                timestamp: Date.now(),
            };
        }
    }


    // 拉取资金费率（使用 Funding API 的 getLatestFundingRate）
    async fetchFundingInfo() {
        const url = `${this.baseUrl}/api/v1/public/funding/getLatestFundingRate`;

        try {
            const resp = await this.requestWithRetry(() =>
                axios.get<{ data: any[] }>(url, {
                    httpsAgent: this.proxyAgent,
                    timeout: this.requestTimeout,
                }),
                'FUNDING'
            );
            // @ts-ignore
            const list = resp.data?.data;
            if (!Array.isArray(list)) {
                throw new Error('Invalid funding data from Edgex');
            }

            let updated = 0;
            for (const item of list) {
                if (!item?.contractId) continue;

                const contractId = String(item.contractId);
                const symbol = this.contractIdToSymbol[contractId];
                if (!symbol) continue;

                const fundingInfo: FundingInfo = {
                    symbol,
                    fundingRate: item.fundingRate != null ? Number(item.fundingRate) : null,
                    fundingTime: item.fundingTime != null ? Number(item.fundingTime) : null,
                    forecastFundingRate: item.forecastFundingRate != null ? Number(item.forecastFundingRate) : null,
                    fundingRateIntervalMin: item.fundingRateIntervalMin != null ? Number(item.fundingRateIntervalMin) : null,
                };

                this.fundingMap[symbol] = fundingInfo;
                updated++;
            }

            if (config.logging.enableFundingLogs) {
                logger.exchangeInfo(this.name, `Fetched ${updated} funding rates`);
            }
        } catch (e: any) {
            // @ts-ignore
            logger.exchangeError(this.name, 'FUNDING', 'fetchFundingRates failed', {
                error: e.message,
            });
            throw e;
        }
    }


    getFundingMap() {
        return this.fundingMap;
    }

    // 为对齐接口，保留空的 WS 断开方法
    disconnect() {
        // 当前使用 REST 轮询，无持久连接
    }

}



