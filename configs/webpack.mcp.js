const { merge } = require('webpack-merge');

module.exports = (env, argv) => {
  const baseConfig = require('./webpack.base.js')(env, argv);

  return merge(baseConfig, {
    entry: ['./src/mcp/bin.ts'],
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true
            }
          }
        }
      ]
    },
    output: {
      filename: 'mcp.bundle.js',
      libraryTarget: 'commonjs2'
    },
    target: 'node'
  });
};
