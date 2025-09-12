const { HttpsProxyAgent } = require('https-proxy-agent');

function getProxyAgent() {
    if (process.env.NO_PROXY === 'true') {
        return null;
    }
    const protocol = process.env.PROXY_PROTOCOL || 'http';
    const host = process.env.PROXY_HOST || '127.0.0.1';
    const port = process.env.PROXY_PORT || '1080';
    const user = process.env.PROXY_USER;
    const pass = process.env.PROXY_PASS;

    const auth = (user && pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
    const proxyUrl = `${protocol}://${auth}${host}:${port}`;

    return new HttpsProxyAgent(proxyUrl);
}

module.exports = {
    getProxyAgent
};