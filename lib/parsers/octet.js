var EventEmitter = require('events').EventEmitter
	, util = require('util');

function OctetParser(options){
	EventEmitter.call(this);
}

util.inherits(OctetParser, EventEmitter);

module.exports = OctetParser;

OctetParser.prototype.write = function(buffer) {
  this.emit('data', buffer);
	return buffer.length;
};

OctetParser.prototype.end = function() {
	this.emit('end');
};
