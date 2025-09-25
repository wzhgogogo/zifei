const ccxt = require('ccxt');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./utils/logger');
const config = require('./config/config');

// 确保这里的端口是正确的
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:1080'); 
const app = express();
const port = 3000; // 使用3000端口避免与其他服务冲突

// 启用CORS和JSON中间件

// 设置静态文件目录
app.use(express.static('public'));

// 渲染index.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// 配置CORS选项
const corsOptions = {
    origin: '*', // 允许所有域名访问，生产环境建议设置为具体的域名
    methods: ['GET', 'POST', 'OPTIONS'], // 允许的HTTP方法
    allowedHeaders: ['Content-Type', 'Authorization'], // 允许的请求头
    exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'], // 允许客户端访问的响应头
    credentials: true, // 允许发送cookies
    maxAge: 86400 // 预检请求的缓存时间（秒）
};

// 启用CORS
app.use(cors(corsOptions));



// 存储最新的交易机会
let latestOpportunities = [];
let lastUpdateTime = null;
// 创建交易对支持映射
let symbolMap = {};


// 筛选规则函数
function filterOpportunity(opportunity, okxTickers, bybitTickers, binanceTickers, bitgetTickers) {
    // 只对 Bitget 进行筛选
    if (opportunity.exchanges.includes('BITGET')) {
        // 获取 Bitget 的交易量
        const bitgetVolume = bitgetTickers[opportunity.symbol]?.volume || 0;
        
        // 获取 Bitget 的资金费率（根据是 A 还是 B 交易所选择正确的字段）
        const bitgetFundingRate = opportunity.exchanges[0] === 'BITGET' ? 
            Math.abs(opportunity['A-FUNDINGRATE']) : 
            Math.abs(opportunity['B-FUNDINGRATE']);
          
        // 交易量必须大于等于 100 万且资金费率绝对值大于等于 0.2%
        if (bitgetVolume < 1000000 || bitgetFundingRate < 0.001 ) {
            return false;
        }
    }

    return true;
}

// 交易所模块导入
const BinanceExchange = require('./exchanges/binance');
const OKXExchange = require('./exchanges/okx');
const BybitExchange = require('./exchanges/bybit');
const BackpackExchange = require('./exchanges/backpack');
const EdgexExchange = require('./dist/edgex');
const HyperliquidExchange = require('./exchanges/hyperliquid'); // 新增

// 初始化交易所实例
const binanceExchange = new BinanceExchange();
const okxExchange = new OKXExchange();
const bybitExchange = new BybitExchange();
const backpackExchange = new BackpackExchange();
const edgexExchange = new EdgexExchange.default(); // 新增
const hyperliquidExchange = new HyperliquidExchange(); // 新增

// 增加：聚合互斥锁，防止主循环重入
// 在全局变量区域添加统计计数器
let statsCounters = {
    tickers: {
        okx: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        bybit: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        binance: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        backpack: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        edgex: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        hyperliquid: { success: 0, errors: 0, skipped: 0, lastUpdate: null } // 新增
    },
    funding: {
        okx: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        bybit: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        binance: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        backpack: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        edgex: { success: 0, errors: 0, skipped: 0, lastUpdate: null },
        hyperliquid: { success: 0, errors: 0, skipped: 0, lastUpdate: null } // 新增
    }
};
// 新增：15分钟聚合快照（用于计算区间增量）
let prevSummarySnapshot = null;

// 在 main() 函数中添加价格统计
async function main() {
    const startedAt = Date.now();

    try {
        logger.info('Starting data aggregation', { category: 'dataAggregation' });
        
        // 获取所有交易所的tickers数据
        const [okxTickers, bybitTickers, binanceTickers, backpackTickers, edgexTickers, hyperliquidTickers] = await Promise.all([
            okxExchange.fetchTickers().then(result => {
                statsCounters.tickers.okx.success++;
                statsCounters.tickers.okx.lastUpdate = new Date();
                return result;
            }).catch(err => {
                statsCounters.tickers.okx.errors++;
                throw err;
            }),
            bybitExchange.fetchTickers().then(result => {
                statsCounters.tickers.bybit.success++;
                statsCounters.tickers.bybit.lastUpdate = new Date();
                return result;
            }).catch(err => {
                statsCounters.tickers.bybit.errors++;
                throw err;
            }),
            binanceExchange.fetchTickers().then(result => {
                statsCounters.tickers.binance.success++;
                statsCounters.tickers.binance.lastUpdate = new Date();
                return result;
            }).catch(err => {
                statsCounters.tickers.binance.errors++;
                throw err;
            }),
            backpackExchange.fetchTickers().then(result => {
                statsCounters.tickers.backpack.success++;
                statsCounters.tickers.backpack.lastUpdate = new Date();
                return result;
            }).catch(err => {
                statsCounters.tickers.backpack.errors++;
                throw err;
            }),
            edgexExchange.tickersMap,
            // edgexExchange.fetchTickers().then(result => {
            //     statsCounters.tickers.edgex.success++;
            //     statsCounters.tickers.edgex.lastUpdate = new Date();
            //     return result;
            // }).catch(err => {
            //     statsCounters.tickers.edgex.errors++;
            //     throw err;
            // }), // 新增
            hyperliquidExchange.fetchTickers().then(result => {
                statsCounters.tickers.hyperliquid.success++;
                statsCounters.tickers.hyperliquid.lastUpdate = new Date();
                return result;
            }).catch(err => {
                statsCounters.tickers.hyperliquid.errors++;
                throw err;
            }) // 新增
        ]);
        
        // 获取资金费率数据
        const okxFundingMap = okxExchange.getFundingMap();
        const bybitFundingMap = bybitExchange.getFundingMap();
        const binanceFundingMap = binanceExchange.getFundingMap();
        const backpackFundingMap = backpackExchange.getFundingMap();
        const edgexFundingMap = edgexExchange.getFundingMap(); // 新增
        const hyperliquidFundingMap = hyperliquidExchange.getFundingMap(); // 新增
        
        // 调试输出 - 仅在启用详细日志时显示
        if (config.logging.enableDetailedLogs) {
            const glmrSymbols = {
                binance: Object.keys(binanceTickers).filter(s => s.includes('GLMR')),
                okx: Object.keys(okxTickers).filter(s => s.includes('GLMR')),
                bybit: Object.keys(bybitTickers).filter(s => s.includes('GLMR')),
                edgex: Object.keys(edgexTickers).filter(s => s.includes('GLMR')),
                backpack: Object.keys(backpackTickers).filter(s => s.includes('GLMR')),
                hyperliquid: Object.keys(hyperliquidTickers).filter(s => s.includes('GLMR')) // 新增
            };
            
            logger.debug('GLMR symbol analysis', {
                category: 'symbolAnalysis',
                glmrSymbols,
                totalSymbols: {
                    binance: Object.keys(binanceTickers).length,
                    okx: Object.keys(okxTickers).length,
                    bybit: Object.keys(bybitTickers).length,
                    backpack: Object.keys(backpackTickers).length,
                    edgex: Object.keys(edgexTickers).length,
                    hyperliquid: Object.keys(hyperliquidTickers).length // 新增
                }
            });
        }
        
        // 替换第243-288行的数据收集逻辑
        const tokenData = {};
        
        // 获取 mid 价：优先 (bid+ask)/2；缺失时回退 last；无效返回 null
        const getMidPrice = (ticker) => {
            const bid = Number(ticker?.bid);
            const ask = Number(ticker?.ask);
            if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
                return (bid + ask) / 2;
            }
            const last = Number(ticker?.last);
            return Number.isFinite(last) && last > 0 ? last : null;
        };
        
        // OKX
        for (const [symbol, ticker] of Object.entries(okxTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0]; // 按币种聚合，避免 USDT/USDC 分裂
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.OKX = {
                price,
                type: '合约',
                fundingRate: okxFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: okxFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BYBIT
        for (const [symbol, ticker] of Object.entries(bybitTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0];
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.BYBIT = {
                price,
                type: '合约',
                fundingRate: bybitFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: bybitFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BINANCE
        for (const [symbol, ticker] of Object.entries(binanceTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0];
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.BINANCE = {
                price,
                type: '合约',
                fundingRate: binanceFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: binanceFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BACKPACK
        for (const [symbol, ticker] of Object.entries(backpackTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0];
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.BACKPACK = {
                price,
                type: '合约',
                fundingRate: backpackFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: backpackFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // EDGEX
        for (const [symbol, ticker] of Object.entries(edgexTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0];
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.EDGEX = {
                price,
                type: '合约',
                fundingRate: edgexFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: edgexFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // HYPERLIQUID - 新增
        for (const [symbol, ticker] of Object.entries(hyperliquidTickers)) {
            const price = getMidPrice(ticker);
            if (!Number.isFinite(price) || price <= 0) continue;
            const key = symbol.split('/')[0];
            if (!tokenData[key]) tokenData[key] = { symbol: key, exchanges: {} };
            tokenData[key].exchanges.HYPERLIQUID = {
                price,
                type: '合约',
                fundingRate: hyperliquidFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: hyperliquidFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // 将聚合结果写入 latestOpportunities，供前端 /api/opportunities 使用
        const aggregatedList = Object.values(tokenData)
            .map(token => {
                const entries = Object.entries(token.exchanges || {});
                if (entries.length < 2) return null; // 至少两个交易所有对比价值

                // 价格端建议（最低价做多，最高价做空）
                const priceEntries = entries.filter(([, d]) => d.price && d.price > 0);
                if (priceEntries.length < 2) return null;

                const minPriceEntry = priceEntries.reduce((a, b) => (a[1].price <= b[1].price ? a : b));
                const maxPriceEntry = priceEntries.reduce((a, b) => (a[1].price >= b[1].price ? a : b));

                // 资金费率端建议（最低费率做多，最高费率做空）
                const fundingEntries = entries.filter(([, d]) => typeof d.fundingRate === 'number');
                const minFundingEntry = fundingEntries.length ? fundingEntries.reduce((a, b) => (a[1].fundingRate <= b[1].fundingRate ? a : b)) : null;
                const maxFundingEntry = fundingEntries.length ? fundingEntries.reduce((a, b) => (a[1].fundingRate >= b[1].fundingRate ? a : b)) : null;

                return {
                    symbol: token.symbol, // 现在是币种名，如 BTC
                    exchanges: token.exchanges,
                    tradingAdvice: {
                        longExchange: minPriceEntry ? minPriceEntry[0] : null,
                        shortExchange: maxPriceEntry ? maxPriceEntry[0] : null,
                        longFunding: minFundingEntry ? minFundingEntry[0] : null,
                        shortFunding: maxFundingEntry ? maxFundingEntry[0] : null
                    }
                };
            })
            .filter(Boolean);

        latestOpportunities = aggregatedList;
        lastUpdateTime = new Date().toISOString();

        // 汇总本轮成功/失败/跳过（tickers 与 funding）
        const tickerTotals = Object.values(statsCounters.tickers).reduce((acc, cur) => ({
            success: acc.success + (cur.success || 0),
            errors:  acc.errors  + (cur.errors  || 0),
            skipped: acc.skipped + (cur.skipped || 0),
        }), { success: 0, errors: 0, skipped: 0 });

        const fundingTotals = Object.values(statsCounters.funding).reduce((acc, cur) => ({
            success: acc.success + (cur.success || 0),
            errors:  acc.errors  + (cur.errors  || 0),
            skipped: acc.skipped + (cur.skipped || 0),
        }), { success: 0, errors: 0, skipped: 0 });

        logger.info('Data aggregation summary', {
            category: 'dataAggregationSummary',
            tokenCount: aggregatedList.length,
            exchangeData: {
                okx: Object.keys(okxTickers).length,
                bybit: Object.keys(bybitTickers).length,
                binance: Object.keys(binanceTickers).length,
                backpack: Object.keys(backpackTickers).length,
                edgex: Object.keys(edgexTickers).length,
                hyperliquid: Object.keys(hyperliquidTickers).length
            },
            // 新增：明确展示成功/失败/跳过
            totals: {
                tickers: {
                    total: tickerTotals.success + tickerTotals.errors + tickerTotals.skipped,
                    success: tickerTotals.success,
                    errors: tickerTotals.errors,
                    skipped: tickerTotals.skipped
                },
                funding: {
                    total: fundingTotals.success + fundingTotals.errors + fundingTotals.skipped,
                    success: fundingTotals.success,
                    errors: fundingTotals.errors,
                    skipped: fundingTotals.skipped
                }
            },
            // 新增：各交易所维度的成功/失败/跳过（便于快速定位异常交易所）
            perExchange: {
                tickers: {
                    OKX: statsCounters.tickers.okx,
                    BYBIT: statsCounters.tickers.bybit,
                    BINANCE: statsCounters.tickers.binance,
                    BACKPACK: statsCounters.tickers.backpack,
                    EDGEX: statsCounters.tickers.edgex,
                    HYPERLIQUID: statsCounters.tickers.hyperliquid
                },
                funding: {
                    OKX: statsCounters.funding.okx,
                    BYBIT: statsCounters.funding.bybit,
                    BINANCE: statsCounters.funding.binance,
                    BACKPACK: statsCounters.funding.backpack,
                    EDGEX: statsCounters.funding.edgex,
                    HYPERLIQUID: statsCounters.funding.hyperliquid
                }
            }
        });

        logger.info('Initial data aggregation completed', {
            category: 'dataAggregation',
            tokenCount: Object.keys(tokenData).length,
            exchangeData: {
                okx: Object.keys(okxTickers).length,
                bybit: Object.keys(bybitTickers).length,
                binance: Object.keys(binanceTickers).length,
                backpack: Object.keys(backpackTickers).length,
                edgex: Object.keys(edgexTickers).length,
                hyperliquid: Object.keys(hyperliquidTickers).length
            }
        });
        
        const aggregationStats = {
            totalTokens: Object.keys(tokenData).length,
            exchangeBreakdown: {
                okx: okxTickers ? Object.keys(okxTickers).length : 0,
                bybit: bybitTickers ? Object.keys(bybitTickers).length : 0,
                binance: binanceTickers ? Object.keys(binanceTickers).length : 0,
                backpack: backpackTickers ? Object.keys(backpackTickers).length : 0,
                edgex: edgexTickers ? Object.keys(edgexTickers).length : 0,
                hyperliquid: hyperliquidTickers ? Object.keys(hyperliquidTickers).length : 0
            },
            // ... existing code ...
        };

        } catch (error) {
            logger.error('Data aggregation failed', {
                category: 'dataAggregation',
                error: error.message,
                stack: error.stack
            });
        } finally {
            // 移除：main 内部释放锁
            if (config.logging.enablePerformanceLogs) {
                logger.info('Aggregation cycle completed', {
                    category: 'dataAggregation',
                    durationMs: Date.now() - startedAt
                });
            }
        }
    }

    // API路由

    // 获取所有交易机会
    app.get('/api/opportunities', (req, res) => {
        res.json({
            "success": true,
            "data": {
                "opportunities": latestOpportunities,
                "lastUpdate": lastUpdateTime,
                "count": latestOpportunities.length
            }
        });
    });

    // 获取特定交易对的机会
    app.get('/api/opportunities/:symbol', (req, res) => {
        const symbol = req.params.symbol.toUpperCase();
        const filteredOpportunities = latestOpportunities.filter(opp => opp.symbol === symbol);
        
        res.json({
            "success": true,
            "data": {
                "opportunities": filteredOpportunities,
                "lastUpdate": lastUpdateTime,
                "count": filteredOpportunities.length
            }
        });
    });

    // 获取特定交易所对的机会
    app.get('/api/opportunities/pair/:pair', (req, res) => {
        const pair = req.params.pair.toUpperCase();
        const filteredOpportunities = latestOpportunities.filter(opp => opp.pair === pair);
        
        res.json({
            "success": true,
            "data": {
                "opportunities": filteredOpportunities,
                "lastUpdate": lastUpdateTime,
                "count": filteredOpportunities.length
            }
        });
    });

    // 获取状态信息
    app.get('/api/status', (req, res) => {
        res.json({
            "success": true,
            "data": {
                "lastUpdate": lastUpdateTime,
                "totalOpportunities": latestOpportunities.length,
                "isRunning": true,
                "bybitFundingMap": bybitExchange.getFundingMap(),
                "okxFundingMap": okxExchange.getFundingMap(),
                "binanceFundingMap": binanceExchange.getFundingMap(),
                "backpackFundingMap": backpackExchange.getFundingMap(),
                "edgexFundingMap": edgexExchange.getFundingMap(), // 新增
                "hyperliquidFundingMap": hyperliquidExchange.getFundingMap() // 新增
            }
        });
    });

    // K线数据接口
    app.get('/api/kline', async (req, res) => {
        try {
            const { 
                exchange = 'binance',
                symbol = 'BTC/USDT', 
                timeframe = '1m', 
                limit = 1000 
            } = req.query;
            
            logger.info('Fetching kline data', {
                category: 'klineRequest',
                exchange,
                symbol,
                timeframe,
                limit
            });
            
            // 创建交易所实例
            const exchangeInstance = createExchange(exchange);
            
            // 获取K线数据
            const ohlcv = await exchangeInstance.fetchOHLCV(symbol, timeframe, undefined, 2000);
            
            // 格式化数据
            const klineData = ohlcv.map(item => ({
                timestamp: item[0],
                open: item[1],
                high: item[2],
                low: item[3],
                close: item[4],
                volume: item[5]
            }));

            logger.success('Kline data fetched successfully', {
                category: 'klineSuccess',
                exchange,
                symbol,
                dataPoints: klineData.length
            });

            res.json({
                success: true,
                data: klineData
            });
        } catch (error) {
            logger.error('Failed to fetch kline data', {
                category: 'klineError',
                exchange: req.query.exchange,
                symbol: req.query.symbol,
                error: error.message,
                stack: error.stack
            });
            
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });
    // 标准交易所ID列表（不包含别名）
    const standardExchangeIds = [
        'binance',
        'okx',
        'gateio',
        'bybit',
        'huobi',
        'kucoin',
        'mexc',
        'phemex'
    ];
    // 支持的交易所列表和ID映射
    const supportedExchanges = {
        // 标准ID映射
        'binance': ccxt.binance,
        'okx': ccxt.okx,
        'gateio': ccxt.gateio,
        'bybit': ccxt.bybit,
        // 别名映射
        'binanceus': ccxt.binanceus,
        'binanceusdm': ccxt.binanceusdm,
        'binancecoinm': ccxt.binancecoinm,
        'okex': ccxt.okx, // OKX的旧名称
        'gate': ccxt.gateio, // Gate.io的别名
        'huobi': ccxt.huobi,
        'kucoin': ccxt.kucoin,
        'mexc': ccxt.mexc,
        'phemex': ccxt.phemex
    };

    const createExchange = (exchangeId) => {
        const normalizedId = exchangeId.toLowerCase();
        if (!supportedExchanges[normalizedId]) {
            throw new Error(`Unsupported exchange: ${exchangeId}. Supported exchanges: ${standardExchangeIds.join(', ')}`);
        }
        return new supportedExchanges[normalizedId]({
            'options':{'defaultType':'swap','enableRateLimit': true,
        },
        });
    };



    // 启动Express服务器

    // 替换原有的 console.log
    // 例如：
    app.listen(config.server.port, async () => {
        logger.info(`API server started`, { 
            port: config.server.port, 
            host: config.server.host 
        });
        
        try {
            // 初始化交易所
            await Promise.all([
                binanceExchange.initialize(),
                okxExchange.initialize(),
                bybitExchange.initialize(),
                backpackExchange.initialize(),
                edgexExchange.initialize(), // 新增
                hyperliquidExchange.initialize() // 新增
            ]);
            
            logger.success('All exchanges initialized successfully');
            
            // 立即获取一次资金费率
            await Promise.all([
                binanceExchange.fetchFundingInfo(),
                okxExchange.fetchFundingInfo(),
                bybitExchange.fetchFundingInfo(),
                backpackExchange.fetchFundingInfo(),
                edgexExchange.fetchFundingInfo(), // 新增
                hyperliquidExchange.fetchFundingInfo() // 新增
            ]);
            
            logger.success('Initial funding info fetched');
            
            // 启动定时任务
            // 串行调度：主循环 runMainOnce 定义与定时器句柄
            let mainTimer = null;
            
            const runMainOnce = () => {
                if (mainTimer) return; // 防止重入
                
                mainTimer = setTimeout(async () => {
                    try {
                        await main();
                    } catch (error) {
                        logger.error('Main cycle error', error);
                    } finally {
                        mainTimer = null;
                        setTimeout(runMainOnce, config.arbitrage.updateInterval);
                    }
                }, 0);
            };
            
            // 启动主循环（串行调度）
            runMainOnce();

            // OKX 定时更新资金费率（新增）
            setInterval(() => {
                okxExchange.fetchFundingInfo()
                    .catch(err => logger.error('OKX funding fetch failed', err));
            }, config.exchanges.okx.fetchInterval);

            // Bybit 定时更新资金费率（新增）
            setInterval(() => {
                bybitExchange.fetchFundingInfo()
                    .catch(err => logger.error('Bybit funding fetch failed', err));
            }, config.exchanges.bybit.fetchInterval);

            // Binance 定时更新资金费率
            setInterval(() => {
                binanceExchange.fetchFundingInfo()
                    .catch(err => logger.error('Binance funding fetch failed', err));
            }, config.exchanges.binance.fetchInterval);

            // Backpack 定时更新资金费率
            setInterval(() => {
                backpackExchange.fetchFundingInfo()
                    .catch(err => logger.error('Backpack funding fetch failed', err));
            }, config.exchanges.backpack.fetchInterval);

            // Edgex 定时更新资金费率
            setInterval(() => {
                edgexExchange.fetchFundingInfo()
                    .catch(err => logger.error('Edgex funding fetch failed', err));
            }, config.exchanges.edgex.fetchInterval);

            // Hyperliquid 定时更新资金费率 - 新增
            setInterval(() => {
                hyperliquidExchange.fetchFundingInfo()
                    .catch(err => logger.error('Hyperliquid funding fetch failed', err));
            }, config.exchanges.hyperliquid.fetchInterval);
            
            logger.info('All scheduled tasks started');
            
        } catch (error) {
            logger.error('Failed to initialize application', error);
            process.exit(1);
        }
    });

    // 优雅关闭处理
    process.on('SIGINT', () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        
        // 断开WebSocket连接
        binanceExchange.disconnect();
        
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        
        // 断开WebSocket连接
        binanceExchange.disconnect();
        
        process.exit(0);
    });

    // 添加WebSocket状态监控端点
    app.get('/api/websocket/status', (req, res) => {
        try {
            const binanceStatus = binanceExchange.getConnectionStatus();
            // 在这里也添加 hyperliquid 的状态
            const hyperliquidStatus = hyperliquidExchange.getConnectionStatus(); // 新增
            
            res.json({
                success: true,
                data: {
                    binance: binanceStatus,
                    hyperliquid: hyperliquidStatus, // 新增
                    // ... 其他交易所状态
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            logger.error('Failed to get WebSocket status', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // 在启动逻辑中添加
    // 15分钟周期汇总
    setInterval(logPeriodicSummary, 15 * 60 * 1000); // 15分钟

    function logPeriodicSummary() {
        const now = new Date();
        const formatTime = (date) => date ? `${Math.round((now - date) / 1000)}s ago` : 'never';
        
        logger.info('📊 Periodic Summary (15min)', { category: 'periodicSummary' });
        
        // 新增：15分钟区间总计（基于快照增量）
        if (!prevSummarySnapshot) {
            // 首次运行，建立基线快照
            prevSummarySnapshot = JSON.parse(JSON.stringify(statsCounters));
        }
        const calcTotals = (section) => {
            let success = 0, errors = 0, skipped = 0;
            for (const ex of Object.keys(statsCounters[section])) {
                const curr = statsCounters[section][ex];
                const prev = prevSummarySnapshot && prevSummarySnapshot[section] && prevSummarySnapshot[section][ex]
                    ? prevSummarySnapshot[section][ex]
                    : { success: 0, errors: 0, skipped: 0 };
                success += Math.max(0, (curr.success || 0) - (prev.success || 0));
                errors += Math.max(0, (curr.errors || 0) - (prev.errors || 0));
                skipped += Math.max(0, (curr.skipped || 0) - (prev.skipped || 0));
            }
            return { total: success + errors + skipped, success, errors, skipped };
        };
        const priceTotals = calcTotals('tickers');
        const fundingTotals = calcTotals('funding');
    
        logger.info('🧮 Price Summary Totals (last 15m)', {
            category: 'periodicSummary',
            total: priceTotals.total,
            success: priceTotals.success,
            errors: priceTotals.errors,
            skipped: priceTotals.skipped
        });
    
        logger.info('🧮 Funding Summary Totals (last 15m)', {
            category: 'periodicSummary',
            total: fundingTotals.total,
            success: fundingTotals.success,
            errors: fundingTotals.errors,
            skipped: fundingTotals.skipped
        });
        
        // 价格数据汇总（累计）
        logger.info('📈 Price Data Summary', {
            category: 'periodicSummary',
            okx: `✅${statsCounters.tickers.okx.success} ❌${statsCounters.tickers.okx.errors} ⏭${statsCounters.tickers.okx.skipped} (${formatTime(statsCounters.tickers.okx.lastUpdate)})`,
            bybit: `✅${statsCounters.tickers.bybit.success} ❌${statsCounters.tickers.bybit.errors} ⏭${statsCounters.tickers.bybit.skipped} (${formatTime(statsCounters.tickers.bybit.lastUpdate)})`,
            binance: `✅${statsCounters.tickers.binance.success} ❌${statsCounters.tickers.binance.errors} ⏭${statsCounters.tickers.binance.skipped} (${formatTime(statsCounters.tickers.binance.lastUpdate)})`,
            backpack: `✅${statsCounters.tickers.backpack.success} ❌${statsCounters.tickers.backpack.errors} ⏭${statsCounters.tickers.backpack.skipped} (${formatTime(statsCounters.tickers.backpack.lastUpdate)})`,
            edgex: `✅${statsCounters.tickers.edgex.success} ❌${statsCounters.tickers.edgex.errors} ⏭${statsCounters.tickers.edgex.skipped} (${formatTime(statsCounters.tickers.edgex.lastUpdate)})`,
            hyperliquid: `✅${statsCounters.tickers.hyperliquid.success} ❌${statsCounters.tickers.hyperliquid.errors} ⏭${statsCounters.tickers.hyperliquid.skipped} (${formatTime(statsCounters.tickers.hyperliquid.lastUpdate)})` // 新增
        });
    
        // 资金费率汇总（累计）
        logger.info('💰 Funding Rate Summary', {
            category: 'periodicSummary',
            okx: `✅${statsCounters.funding.okx.success} ❌${statsCounters.funding.okx.errors} ⏭${statsCounters.funding.okx.skipped} (${formatTime(statsCounters.funding.okx.lastUpdate)})`,
            bybit: `✅${statsCounters.funding.bybit.success} ❌${statsCounters.funding.bybit.errors} ⏭${statsCounters.funding.bybit.skipped} (${formatTime(statsCounters.funding.bybit.lastUpdate)})`,
            binance: `✅${statsCounters.funding.binance.success} ❌${statsCounters.funding.binance.errors} ⏭${statsCounters.funding.binance.skipped} (${formatTime(statsCounters.funding.binance.lastUpdate)})`,
            backpack: `✅${statsCounters.funding.backpack.success} ❌${statsCounters.funding.backpack.errors} ⏭${statsCounters.funding.backpack.skipped} (${formatTime(statsCounters.funding.backpack.lastUpdate)})`,
            edgex: `✅${statsCounters.funding.edgex.success} ❌${statsCounters.funding.edgex.errors} ⏭${statsCounters.funding.edgex.skipped} (${formatTime(statsCounters.funding.edgex.lastUpdate)})`,
            hyperliquid: `✅${statsCounters.funding.hyperliquid.success} ❌${statsCounters.funding.hyperliquid.errors} ⏭${statsCounters.funding.hyperliquid.skipped} (${formatTime(statsCounters.funding.hyperliquid.lastUpdate)})` // 新增
        });
    
        // 更新基线快照，供下一次15分钟统计
        prevSummarySnapshot = JSON.parse(JSON.stringify(statsCounters));
    } // 仅保留这个右花括号作为函数结尾（删除紧随其后的多余两个右花括号）






