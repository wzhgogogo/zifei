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

// 初始化交易所实例
const binanceExchange = new BinanceExchange();
const okxExchange = new OKXExchange();
const bybitExchange = new BybitExchange();
const backpackExchange = new BackpackExchange();


async function main() {
    try {
        // 在数据聚合函数中添加更详细的统计
        logger.info('Starting data aggregation', { category: 'dataAggregation' });
        
        // 获取所有交易所的tickers数据
        const [okxTickers, bybitTickers, binanceTickers, backpackTickers] = await Promise.all([
            okxExchange.fetchTickers(),
            bybitExchange.fetchTickers(),
            binanceExchange.fetchTickers(),
            backpackExchange.fetchTickers()
        ]);
        
        // 获取资金费率数据
        const okxFundingMap = okxExchange.getFundingMap();
        const bybitFundingMap = bybitExchange.getFundingMap();
        const binanceFundingMap = binanceExchange.getFundingMap();
        const backpackFundingMap = backpackExchange.getFundingMap();
        
        // 调试输出 - 仅在启用详细日志时显示
        if (config.logging.enableDetailedLogs) {
            const glmrSymbols = {
                binance: Object.keys(binanceTickers).filter(s => s.includes('GLMR')),
                okx: Object.keys(okxTickers).filter(s => s.includes('GLMR')),
                bybit: Object.keys(bybitTickers).filter(s => s.includes('GLMR'))
            };
            
            logger.debug('GLMR symbol analysis', {
                category: 'symbolAnalysis',
                glmrSymbols,
                totalSymbols: {
                    binance: Object.keys(binanceTickers).length,
                    okx: Object.keys(okxTickers).length,
                    bybit: Object.keys(bybitTickers).length,
                    backpack: Object.keys(backpackTickers).length
                }
            });
        }
        
        // 替换第243-288行的数据收集逻辑
        const tokenData = {};
        
        // OKX
        for (const [symbol, ticker] of Object.entries(okxTickers)) {
            if (!ticker.last || ticker.last <= 0) continue;
            if (!tokenData[symbol]) tokenData[symbol] = { symbol: symbol, exchanges: {} };
            tokenData[symbol].exchanges.OKX = {
                price: ticker.last,
                type: '合约',
                fundingRate: okxFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: okxFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BYBIT
        for (const [symbol, ticker] of Object.entries(bybitTickers)) {
            if (!ticker.last || ticker.last <= 0) continue;
            if (!tokenData[symbol]) tokenData[symbol] = { symbol: symbol, exchanges: {} };
            tokenData[symbol].exchanges.BYBIT = {
                price: ticker.last,
                type: '合约',
                fundingRate: bybitFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: bybitFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BINANCE
        for (const [symbol, ticker] of Object.entries(binanceTickers)) {
            if (!ticker.last || ticker.last <= 0) continue;
            if (!tokenData[symbol]) tokenData[symbol] = { symbol: symbol, exchanges: {} };
            tokenData[symbol].exchanges.BINANCE = {
                price: ticker.last,
                type: '合约',
                fundingRate: binanceFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: binanceFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || 0
            };
        }

        // BACKPACK
        for (const [symbol, ticker] of Object.entries(backpackTickers)) {
            if (!ticker.last || ticker.last <= 0) continue;
            if (!tokenData[symbol]) tokenData[symbol] = { symbol: symbol, exchanges: {} };
            tokenData[symbol].exchanges.BACKPACK = {
                price: ticker.last,
                type: '合约',
                fundingRate: backpackFundingMap[symbol]?.fundingRate || 0,
                nextFundingTime: backpackFundingMap[symbol]?.fundingTime || 0,
                volume: ticker.baseVolume || ticker.volume || 0
            };
        }
    
        // 计算交易建议并保留所有有数据的代币
        for (const token of Object.values(tokenData)) {
            const exchanges = Object.entries(token.exchanges);
            if (exchanges.length < 2) continue;
    
            const prices = exchanges.map(([_, data]) => data.price);
            const maxPrice = Math.max(...prices);
            const minPrice = Math.min(...prices);
            
            const maxPriceExchange = exchanges.find(([_, data]) => data.price === maxPrice)[0];
            const minPriceExchange = exchanges.find(([_, data]) => data.price === minPrice)[0];
    
            const rates = exchanges.filter(([_, data]) => data.type === '合约').map(([_, data]) => data.fundingRate);
            const maxRate = Math.max(...rates);
            const minRate = Math.min(...rates);
            
            const maxRateExchange = exchanges.find(([_, data]) => data.fundingRate === maxRate)[0];
            const minRateExchange = exchanges.find(([_, data]) => data.fundingRate === minRate)[0];
    
            token.tradingAdvice = {
                longExchange: minPriceExchange,
                shortExchange: maxPriceExchange,
                longFunding: minRateExchange,
                shortFunding: maxRateExchange,
                priceSpread: ((maxPrice - minPrice) / minPrice * 100).toFixed(2),
                rateSpread: ((maxRate - minRate) * 100).toFixed(2)
            };
        }
    
        // 保留所有有多个交易所数据的代币
        latestOpportunities = Object.values(tokenData).filter(token => 
            Object.keys(token.exchanges).length >= 2
        );
    
        // 添加套利类型分类统计
        const arbitrageAnalysis = {
            priceArbitrage: 0,      // 价差套利
            fundingArbitrage: 0,    // 费率差套利
            bothArbitrage: 0,       // 同时满足两种套利
            totalOpportunities: latestOpportunities.length
        };
    
        // 定义套利阈值（可以从config中获取）
        const priceSpreadThreshold = config.arbitrage?.minProfitThreshold || 0.1; // 0.1%
        const fundingRateThreshold = 0.05; // 0.05% 费率差阈值
    
        // 分析每个套利机会的类型
        latestOpportunities.forEach(token => {
            const priceSpread = parseFloat(token.tradingAdvice?.priceSpread || 0);
            const rateSpread = parseFloat(token.tradingAdvice?.rateSpread || 0);
            
            const hasPriceArbitrage = priceSpread >= priceSpreadThreshold;
            const hasFundingArbitrage = rateSpread >= fundingRateThreshold;
            
            if (hasPriceArbitrage && hasFundingArbitrage) {
                arbitrageAnalysis.bothArbitrage++;
            } else if (hasPriceArbitrage) {
                arbitrageAnalysis.priceArbitrage++;
            } else if (hasFundingArbitrage) {
                arbitrageAnalysis.fundingArbitrage++;
            }
        });
    
        // 更新时间戳
        lastUpdateTime = new Date().toISOString();
    
        // 修改第一个日志，添加套利类型统计
        logger.success('Arbitrage opportunities identified', {
            category: 'dataAggregationSummary',
            tokenCount: latestOpportunities.length,
            updateTime: lastUpdateTime,
            arbitrageBreakdown: {
                priceArbitrage: arbitrageAnalysis.priceArbitrage,
                fundingArbitrage: arbitrageAnalysis.fundingArbitrage, 
                bothTypes: arbitrageAnalysis.bothArbitrage,
                total: arbitrageAnalysis.totalOpportunities
            },
            exchangeData: {
                okx: Object.keys(okxTickers).length,
                bybit: Object.keys(bybitTickers).length,
                binance: Object.keys(binanceTickers).length,
                backpack: Object.keys(backpackTickers).length
            }
        });
        
        // 聚合数据后添加详细统计 - 修复aggregatedData未定义问题
        const aggregationStats = {
            totalTokens: Object.keys(tokenData).length,
            exchangeBreakdown: {
                okx: okxTickers ? Object.keys(okxTickers).length : 0,
                bybit: bybitTickers ? Object.keys(bybitTickers).length : 0,
                binance: binanceTickers ? Object.keys(binanceTickers).length : 0,
                backpack: backpackTickers ? Object.keys(backpackTickers).length : 0
            },
            // 添加价差条件统计
            priceSpreadAnalysis: {
                totalChecked: Object.keys(tokenData).length,
                meetingSpreadCondition: Object.keys(tokenData).length, // 当前默认全部满足
                spreadThreshold: '配置的价差阈值' // 从config中获取
            },
            // 添加资金费率条件统计
            fundingRateAnalysis: {
                totalChecked: Object.keys(tokenData).length,
                meetingFundingCondition: Object.keys(tokenData).length, // 当前默认全部满足
                fundingThreshold: '配置的费率差阈值' // 从config中获取
            }
        };
        
        // 第二个日志改为
        logger.info('Total data collection completed', {
        category: 'dataAggregationSummary', 
        tokenCount: aggregationStats.totalTokens,  // 736 - 总收集数
        updateTime: new Date().toISOString(),
        exchangeData: aggregationStats.exchangeBreakdown,
        priceSpreadStats: aggregationStats.priceSpreadAnalysis,
        fundingRateStats: aggregationStats.fundingRateAnalysis,
        description: `聚合了${aggregationStats.totalTokens}个代币的价格和资金费率数据，当前所有代币都满足价差和费率差条件（待实现具体筛选逻辑）`
        });
        // 删除下面两行重复的代码：
        // description: `聚合了${aggregationStats.totalTokens}个代币的价格和资金费率数据，当前所有代币都满足价差和费率差条件（待实现具体筛选逻辑）`
        // });
    
    } catch (error) {
        logger.error('Data aggregation failed', {
            category: 'dataAggregationError',
            error: error.message,
            stack: error.stack
        });
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
            "backpackFundingMap": backpackExchange.getFundingMap()
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
            backpackExchange.initialize()
        ]);
        
        logger.success('All exchanges initialized successfully');
        
        // 立即获取一次资金费率
        await Promise.all([
            binanceExchange.fetchFundingInfo(),
            okxExchange.fetchFundingInfo(),
            bybitExchange.fetchFundingInfo(),
            backpackExchange.fetchFundingInfo()
        ]);
        
        logger.success('Initial funding info fetched');
        
        // 启动定时任务
        setInterval(main, config.arbitrage.updateInterval);
        setInterval(() => {
            binanceExchange.fetchFundingInfo()
                .catch(err => logger.error('Binance funding fetch failed', err));
        }, config.exchanges.binance.fetchInterval);

        // Backpack 定时更新资金费率
        setInterval(() => {
            backpackExchange.fetchFundingInfo()
                .catch(err => logger.error('Backpack funding fetch failed', err));
        }, config.exchanges.backpack.fetchInterval);
        
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
        
        res.json({
            success: true,
            data: {
                binance: binanceStatus,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error('Failed to get WebSocket status', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get WebSocket status'
        });
    }
});




