const fs = require('fs');
const path = require('path');
const config = require('../config/config');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '../logs');
        this.ensureLogDir();
        
        // 日志级别映射
        this.levels = {
            'debug': 0,
            'info': 1,
            'warn': 2,
            'error': 3
        };
        
        // 当前日志级别
        this.currentLevel = this.levels[config.logging?.level || 'info'];
        
        // 日志详细程度控制
        this.enableDetailedFunding = config.logging?.enableDetailedFunding ?? false;
        this.enableTickerLogs = config.logging?.enableTickerLogs ?? false;
    }

    ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    // 统一的日志格式化方法
    formatMessage(level, exchange = null, category = null, message, data = null) {
        // 获取北京时间 (UTC+8)
        const now = new Date();
        const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const timestamp = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
        
        const logEntry = {
            timestamp,
            level,
            ...(exchange && { exchange }),
            ...(category && { category }),
            message
        };
        
        if (data !== null) {
            logEntry.data = data;
        }
        
        return JSON.stringify(logEntry);
    }

    writeToFile(filename, message) {
        const filePath = path.join(this.logDir, filename);
        fs.appendFileSync(filePath, message + '\n');
    }

    // 检查日志级别
    shouldLog(level) {
        return this.levels[level] >= this.currentLevel;
    }

    // 基础日志方法
    // 保留这个原始的log方法（第65行）
    log(level, exchange, category, message, data = null, emoji = '') {
        if (!this.shouldLog(level)) return;
        
        const formatted = this.formatMessage(level, exchange, category, message, data);
        
        // 获取北京时间戳用于控制台输出
        const now = new Date();
        const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const timestamp = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
        
        // 控制台输出 - 包含时间戳和关键统计信息
        let consoleMessage = `[${timestamp}] ${emoji} ${message}`;
        if (exchange) {
            consoleMessage = `[${timestamp}] ${emoji} [${exchange.toUpperCase()}] ${message}`;
        }
        
        // 对于数据聚合相关的日志，显示关键统计信息
        if (data && data.category === 'dataAggregationSummary') {
            const stats = [];
            if (data.tokenCount) stats.push(`${data.tokenCount} tokens`);
            
            // 添加套利类型统计显示
            if (data.arbitrageBreakdown) {
                const breakdown = data.arbitrageBreakdown;
                const arbitrageStats = [];
                if (breakdown.priceArbitrage > 0) arbitrageStats.push(`价差:${breakdown.priceArbitrage}`);
                if (breakdown.fundingArbitrage > 0) arbitrageStats.push(`费率:${breakdown.fundingArbitrage}`);
                if (breakdown.bothTypes > 0) arbitrageStats.push(`双重:${breakdown.bothTypes}`);
                
                if (arbitrageStats.length > 0) {
                    stats.push(`[${arbitrageStats.join(', ')}]`);
                }
            }
            
            if (data.exchangeData) {
                const exchangeCounts = Object.entries(data.exchangeData)
                    .map(([ex, count]) => `${ex.toUpperCase()}:${count}`)
                    .join(', ');
                stats.push(`[${exchangeCounts}]`);
            }
            if (stats.length > 0) {
                consoleMessage += ` (${stats.join(', ')})`;
            }
        }
        
        // 修复：只输出消息，不输出data对象
        if (level === 'error') {
            console.error(consoleMessage);
        } else if (level === 'warn') {
            console.warn(consoleMessage);
        } else {
            console.log(consoleMessage);
        }
        
        // 文件输出 - 使用完整的JSON格式
        this.writeToFile('app.log', formatted);
        
        if (level === 'error') {
            this.writeToFile('error.log', formatted);
        }
        
        if (exchange) {
            this.writeToFile('exchange.log', formatted);
        }
    }

    // 删除第234-267行的重复log方法

    // 通用日志方法
    info(message, data = null) {
        this.log('info', null, null, message, data, 'ℹ️');
    }

    error(message, error = null) {
        const errorData = error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
        } : null;
        this.log('error', null, null, message, errorData, '❌');
    }

    warn(message, data = null) {
        this.log('warn', null, null, message, data, '⚠️');
    }

    success(message, data = null) {
        this.log('info', null, 'SUCCESS', message, data, '✅');
    }

    debug(message, data = null) {
        this.log('debug', null, 'DEBUG', message, data, '🔍');
    }

    // 交易所专用日志方法
    exchangeInfo(exchange, category, message, data = null) {
        this.log('info', exchange, category, message, data, '🔄');
    }

    exchangeError(exchange, category, message, error = null) {
        const errorData = error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
        } : null;
        this.log('error', exchange, category, message, errorData, '❌');
    }

    exchangeSuccess(exchange, category, message, data = null) {
        this.log('info', exchange, category, message, data, '✅');
    }

    exchangeWarn(exchange, category, message, data = null) {
        this.log('warn', exchange, category, message, data, '⚠️');
    }

    // 交易所初始化日志
    exchangeInit(exchange, success = true, error = null) {
        if (success) {
            this.exchangeSuccess(exchange, 'INIT', 'Exchange initialized successfully');
        } else {
            this.exchangeError(exchange, 'INIT', 'Exchange initialization failed', error);
        }
    }

    // 资金费率日志
    fundingInfo(exchange, message, data = null) {
        if (this.enableDetailedFunding) {
            this.exchangeInfo(exchange, 'FUNDING', message, data);
        }
    }

    fundingSuccess(exchange, message, data = null) {
        this.exchangeSuccess(exchange, 'FUNDING', message, data);
    }

    fundingError(exchange, message, error = null) {
        this.exchangeError(exchange, 'FUNDING', message, error);
    }

    fundingWarn(message, data = {}) {
        // 修复：使用正确的log方法签名
        this.log('warn', data.exchange || null, 'FUNDING', message, data, '⚠️');
    }

    fundingSummary(exchange, message, data = null) {
        if (typeof message === 'object' && message !== null) {
            // 如果第二个参数是对象，说明是新的调用方式
            const { successCount, errorCount, totalSymbols, totalReceived } = message;
            const summaryMessage = totalSymbols 
                ? `Funding rate fetch completed: ${successCount || 0} success, ${errorCount || 0} errors, ${totalSymbols} total symbols${totalReceived ? `, ${totalReceived} received` : ''}`
                : `Funding rate fetch completed: ${successCount || 0} success, ${errorCount || 0} errors`;
            this.exchangeSuccess(exchange, 'FUNDING', summaryMessage, data);
        } else {
            // 修复：正确处理当前的调用方式
            if (data && typeof data === 'object') {
                const { successCount, errorCount, totalSymbols, totalReceived } = data;
                const summaryMessage = totalSymbols 
                    ? `${message}: ${successCount || 0} success, ${errorCount || 0} errors, ${totalSymbols} total symbols${totalReceived ? `, ${totalReceived} received` : ''}`
                    : `${message}: ${successCount || 0} success, ${errorCount || 0} errors`;
                this.exchangeSuccess(exchange, 'FUNDING', summaryMessage);
            } else {
                // 兼容旧的调用方式
                const successCount = message;
                const errorCount = data;
                const totalSymbols = arguments[3];
                const summaryMessage = totalSymbols 
                    ? `Funding rates updated: ${successCount} success, ${errorCount} errors, ${totalSymbols} total symbols`
                    : `Funding rates updated: ${successCount} success, ${errorCount} errors`;
                this.exchangeSuccess(exchange, 'FUNDING', summaryMessage);
            }
        }
    }

    // Ticker 数据日志
    tickerInfo(exchange, message, data = null) {
        if (this.enableTickerLogs) {
            this.exchangeInfo(exchange, 'TICKER', message, data);
        }
    }

    tickerSuccess(exchange, count) {
        this.exchangeSuccess(exchange, 'TICKER', `${count} tickers fetched successfully`);
    }

    tickerError(exchange, error) {
        this.exchangeError(exchange, 'TICKER', 'Failed to fetch tickers', error);
    }

    // 性能监控日志
    performance(exchange, category, message, duration = null) {
        const perfMessage = duration ? `${message} (${duration}ms)` : message;
        this.log('info', exchange, `PERF-${category}`, perfMessage, null, '⚡');
    }

    // WebSocket 连接日志
    websocket(exchange, status, message = null) {
        const statusEmoji = {
            'connected': '🔗',
            'disconnected': '🔌',
            'reconnecting': '🔄',
            'error': '❌'
        };
        
        const logMessage = message || `WebSocket ${status}`;
        const level = status === 'error' ? 'error' : 'info';
        
        this.log(level, exchange, 'WEBSOCKET', logMessage, null, statusEmoji[status] || '🔗');
    }

    // 兼容旧的 exchange 方法
    exchange(exchange, action, data = null) {
        this.exchangeInfo(exchange, 'GENERAL', action, data);
    }
}

module.exports = new Logger();