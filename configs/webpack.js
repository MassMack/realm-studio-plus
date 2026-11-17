const mainConfig = require('./webpack.main.js');
const rendererConfig = require('./webpack.renderer.js');
const mcpConfig = require('./webpack.mcp.js');

module.exports = [mainConfig, rendererConfig, mcpConfig];
