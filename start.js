require('tsconfig-paths').register({
    baseUrl: './dest/src',
    paths: {
        '@/*': ['./*'],
    }
});

require('./dest/src/main.js');
