#!/usr/bin/env node
'use strict';

const path = require('path');
const moduleAlias = require('module-alias');

// Resolve @/* to the compiled source dir relative to THIS bin script, not cwd.
// This is the only reliable way for a globally-installed CLI: module-alias's
// auto-discovery walks up from process.cwd() and finds the wrong package.json
// when the consumer runs us from inside another project.
const pkgRoot = path.resolve(__dirname, '..');
moduleAlias.addAliases({
    '@': path.join(pkgRoot, 'dest', 'src'),
});

require(path.join(pkgRoot, 'dest', 'src', 'main.js'));
