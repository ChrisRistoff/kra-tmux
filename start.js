require('tsconfig-paths').register({
    baseUrl: './dest/src',
    paths: {
        '@/*': ['./*'],
        '@utils/*': ['utils/*'],
        '@customTypes/*': ['types/*'],
        '@tmux/*': ['tmux/*'],
        '@system/*': ['system/*'],
        '@git/*': ['git/*'],
        '@UI/*': ['UI/*'],
        '@commandsMaps/*': ['commandsMaps/*'],
        '@helpers/*': ['helpers/*'],
        '@filePaths': ['filePaths.js']
    }
});

require('./dest/src/main.js');
