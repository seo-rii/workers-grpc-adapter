'use strict';
const { inspect } = require('../src/build/doctor.cjs');
if (require.main === module) {
  process.exitCode = require('../src/build/doctor-cli.cjs').main(process.argv.slice(2), {
    projectRoot: require('node:path').resolve(__dirname, '../fixtures/google'), profile: 'google-static-v1',
  });
}
module.exports = { inspect };
