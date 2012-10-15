var path = require('path');

global.LIB = path.join(__dirname, '../../lib');
global.FORMIDABLE = path.join(LIB, 'incoming_form')
global.TEST_PORT = 13532;
global.TEST_FIXTURES = path.join(__dirname, '../fixture');
global.TEST_TMP = path.join(__dirname, '../tmp');

