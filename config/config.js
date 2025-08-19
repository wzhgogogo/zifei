// 在文件顶部添加
require('dotenv').config();

const config = {
    // 服务器配置
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || 'localhost'
    },

    // 交易所配置
    exchanges: {
        binance: {
            enabled: true,
            fetchInterval: 60000,
            retryAttempts: 3,
            timeout: 10000
        },
        okx: {
            enabled: true,
            fetchInterval: 60000,
            retryAttempts: 3,
            timeout: 10000
        },
        bybit: {
            enabled: true,
            fetchInterval: 60000,
            retryAttempts: 3,
            timeout: 10000
        },
        backpack: {
            enabled: true,
            fetchInterval: 60000,
            retryAttempts: 3,
            timeout: 10000
        }
    },

    // 套利配置
    arbitrage: {
        updateInterval: 5000,
        minProfitThreshold: 0.3, // 价差套利最小阈值 0.1%
        minFundingThreshold: 0.3, // 费率差套利最小阈值 0.05%
        maxSpread: 10,
        enabledPairs: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT']
    },

    // 日志配置
    logging: {
        level: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
        maxFileSize: '10MB',
        maxFiles: 5,
        enableConsole: true,
        enableFile: true,
        // 新增的详细程度控制
        enableDetailedFunding: process.env.ENABLE_DETAILED_FUNDING === 'true' || false, // 是否显示详细的资金费率日志
        enableTickerLogs: process.env.ENABLE_TICKER_LOGS === 'true' || false, // 是否显示价格数据日志
        enablePerformanceLogs: process.env.ENABLE_PERFORMANCE_LOGS === 'false' || true, // 是否显示性能日志
        enableWebSocketLogs: process.env.ENABLE_WEBSOCKET_LOGS === 'true' || true // 是否显示WebSocket日志
    },

    // 代理配置
    proxy: {
        enabled: process.env.USE_PROXY === 'true',
        host: process.env.PROXY_HOST,
        port: process.env.PROXY_PORT,
        auth: {
            username: process.env.PROXY_USER,
            password: process.env.PROXY_PASS
        }
    }
};

module.exports = config;