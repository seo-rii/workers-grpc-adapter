'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Installed peers can resolve to the repository's already-installed tools.
// Accept only packages covered by the fixture lock or that explicit parent
// lock; an arbitrary package outside those node_modules trees is not evidence
// that a clean fixture installation reproduced its locked graph.
function matchesFixtureLocks(report, fixture, fixtureLock, repository, repositoryLock, installedRepositoryLock) {
    return report.results.every(result => result.graph.every(item => {
        const absolute = path.resolve(fixture, item.path);
        const local = path.relative(fixture, absolute).split(path.sep).join('/');
        if (local.startsWith('node_modules/')) {
            const locked = fixtureLock.packages[local];
            return !!locked && locked.version === item.version && (locked.integrity ?? null) === item.integrity;
        }
        const modules = fs.realpathSync(path.join(repository, 'node_modules'));
        const relative = path.relative(modules, absolute).split(path.sep).join('/');
        if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
        const parent = 'node_modules/' + relative;
        // Doctor attaches integrity only from the inspected project's lock.
        // These ancestor packages are installed separately by the root npm ci.
        const locked = repositoryLock.packages[parent];
        const installed = installedRepositoryLock.packages[parent];
        return !!locked && !!installed && locked.version === item.version && installed.version === item.version
            && (locked.integrity ?? null) === (installed.integrity ?? null) && item.integrity === null;
    }));
}
module.exports = { matchesFixtureLocks };
