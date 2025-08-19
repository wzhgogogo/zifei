const { HttpsProxyAgent } = require('https-proxy-agent');

function getProxyAgent() {
    if (process.env.NO_PROXY === 'true') {
        return null;
    }
    return new HttpsProxyAgent('http://127.0.0.1:1080');
}

module.exports = {
    getProxyAgent
};