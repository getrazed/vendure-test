const path = require('node:path');

/**
 * @return {string}
 */
function getPackageDir() {
    const packageArg = process.env.PACKAGE || process.argv.find(arg => arg.startsWith('--package='));
    const packageDirname = packageArg ? packageArg.split('=')[1] ?? packageArg : inferPackageFromCwd();
    if (!packageDirname) {
        console.error(
            'No package specified! Please pass --package=<packageDirName> or run from packages/<packageDirName>.',
        );
        process.exit(1);
    }
    return path.join(__dirname, '../packages', packageDirname, 'e2e');
}

function inferPackageFromCwd() {
    const cwdParts = process.cwd().split(path.sep);
    const packagesIndex = cwdParts.lastIndexOf('packages');
    if (packagesIndex !== -1 && cwdParts.length > packagesIndex + 1) {
        return cwdParts[packagesIndex + 1];
    }
}

module.exports = { getPackageDir };
