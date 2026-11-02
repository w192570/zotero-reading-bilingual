const fs = require('node:fs');
const path = require('node:path');
module.exports = () => fs.readFileSync(path.resolve(__dirname, '../../content/scripts/figure-cache.js'), 'utf8') + '\n'
  + fs.readFileSync(process.env.ZRB_FIGURE_SOURCE || path.resolve(__dirname, '../../content/scripts/pdf-figure-fallback.js'), 'utf8');
