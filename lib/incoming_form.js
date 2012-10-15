var fs = require('fs'),
    util = require('util'),
    path = require('path'),
    File = require('./file'),
    StringDecoder = require('string_decoder').StringDecoder,
    EventEmitter = require('events').EventEmitter,
    Stream = require('stream').Stream,
    os = require('os');

var parsers = {
  'application/octet-stream': require('./parsers/octet'),
  'application/x-www-form-urlencoded': require('./parsers/querystring'),
  'multipart/form-data': require('./parsers/multipart'),
};

function IncomingForm(opts) {
  EventEmitter.call(this);

  opts=opts||{};

  this.error = null;
  this.ended = false;

  this.maxFieldsSize = opts.maxFieldsSize || 2 * 1024 * 1024;
  this.uploadDir = opts.uploadDir || os.tmpDir();
  this.encoding = opts.encoding || 'utf-8';
  this.hash = opts.hash;

  this.bytesReceived = 0;
  this.bytesExpected = null;

  this._parser = null;
  this._flushing = 0;
  this._fieldsSize = 0;
  this.openedFiles = [];

  return this;
};
util.inherits(IncomingForm, EventEmitter);
exports.IncomingForm = IncomingForm;

IncomingForm.prototype.parse = function(req, cb) {
  var self, fields, files, contentType, contentLength, Parser;

  self = this;

  contentType = req.headers['content-type'];

  if (!contentType) {
    self._error(new Error('bad content-type header, no content-type'));
    return;
  }

  Parser = parsers[contentType];

  if (!Parser) {
    self._error(new Error('bad content-type header, unknown content-type: ' + contentType));
    return;
  }
  self.pause = function() {
    try {
      req.pause();
    } catch (err) {
      // the stream was destroyed
      if (!self.ended) {
        // before it was completed, crash & burn
        self._error(err);
      }
      return false;
    }
    return true;
  };

  self.resume = function() {
    try {
      req.resume();
    } catch (err) {
      // the stream was destroyed
      if (!self.ended) {
        // before it was completed, crash & burn
        self._error(err);
      }
      return false;
    }

    return true;
  };

  contentLength = req.headers['content-length'];

  if (contentLength != null) {
    self.bytesExpected = parseInt(contentLength, 10);
  }
  self.emitProgress();


  self._parser = new Parser(req);

  req
    .on('error', function(err) {
      self._error(err);
    })
    .on('data', function(buffer) {
      var bytesParsed;

      self.bytesReceived += buffer.length;
      self.emitProgress();

      bytesParsed = self._parser.write(buffer);
      if (bytesParsed !== buffer.length) {
        self._error(new Error('parser error, '+bytesParsed+' of '+buffer.length+' bytes parsed'));
      }
    })
    .on('end', function() {
      if (self.error) {
        return;
      }

      var err = self._parser.end();
      if (err) {
        self._error(err);
      }
    });

  if (cb) {
    fields = {};
    files = {};
    self
      .on('field', function(name, value) {
        fields[name] = value;
      })
      .on('file', function(name, file) {
        files[name] = file;
      })
      .on('error', function(err) {
        cb(err, fields, files);
      })
      .on('end', function() {
        cb(null, fields, files);
      });
  }

  return self;
};


IncomingForm.prototype.emitProgress = function() {
  this.emit('progress', this.bytesReceived, this.bytesExpected);
}

IncomingForm.prototype.pause = function() {
  // this does nothing, unless overwritten in IncomingForm.parse
  return false;
};

IncomingForm.prototype.resume = function() {
  // this does nothing, unless overwritten in IncomingForm.parse
  return false;
};

IncomingForm.prototype.onPart = function(part) {
  // this method can be overwritten by the user
  this.handlePart(part);
};

IncomingForm.prototype.handlePart = function(part) {
  var self = this;

  if (part.filename === undefined) {
    var value = ''
      , decoder = new StringDecoder(this.encoding);

    part.on('data', function(buffer) {
      self._fieldsSize += buffer.length;
      if (self._fieldsSize > self.maxFieldsSize) {
        self._error(new Error('maxFieldsSize exceeded, received '+self._fieldsSize+' bytes of field data'));
        return;
      }
      value += decoder.write(buffer);
    });

    part.on('end', function() {
      self.emit('field', part.name, value);
    });
    return;
  }

  this._flushing++;

  var file = new File({
    path: this._uploadPath(part.filename),
    name: part.filename,
    type: part.mime,
    hash: self.hash
  });

  this.emit('fileBegin', part.name, file);

  file.open();
  this.openedFiles.push(file);

  part.on('data', function(buffer) {
    self.pause();
    file.write(buffer, function() {
      self.resume();
    });
  });

  part.on('end', function() {
    file.end(function() {
      self._flushing--;
      self.emit('file', part.name, file);
      self._maybeEnd();
    });
  });
};


IncomingForm.prototype._error = function(err) {
  if (this.error) {
    return;
  }

  this.error = err;
  this.pause();
  this.emit('error', err);

  this.openedFiles.forEach(function(file) {
    file._writeStream.destroy();
    process.nextTick(function () {
      fs.unlink(file.path);
    });
  });
};

IncomingForm.prototype._newParser = function() {
  return new MultipartParser();
};

IncomingForm.prototype._initMultipart = function(boundary) {
  var parser = new MultipartParser(),
      self = this,
      headerField,
      headerValue,
      part;

  parser.initWithBoundary(boundary);

  parser.onPartBegin = function() {
    part = new Stream();
    part.readable = true;
    part.headers = {};
    part.name = null;
    part.filename = null;
    part.mime = null;
    headerField = '';
    headerValue = '';
  };

  parser.onHeaderField = function(b, start, end) {
    headerField += b.toString(self.encoding, start, end);
  };

  parser.onHeaderValue = function(b, start, end) {
    headerValue += b.toString(self.encoding, start, end);
  };

  parser.onHeaderEnd = function() {
    headerField = headerField.toLowerCase();
    part.headers[headerField] = headerValue;

    var m;
    if (headerField == 'content-disposition') {
      if (m = headerValue.match(/name="([^"]+)"/i)) {
        part.name = m[1];
      }

      part.filename = self._fileName(headerValue);
    } else if (headerField == 'content-type') {
      part.mime = headerValue;
    }

    headerField = '';
    headerValue = '';
  };

  parser.onHeadersEnd = function() {
    self.onPart(part);
  };

  parser.onPartData = function(b, start, end) {
    part.emit('data', b.slice(start, end));
  };

  parser.onPartEnd = function() {
    part.emit('end');
  };

  parser.onEnd = function() {
    self.ended = true;
    self._maybeEnd();
  };

  this._parser = parser;
};

IncomingForm.prototype._fileName = function(headerValue) {
  var m = headerValue.match(/filename="(.*?)"($|; )/i);
  if (!m) return;

  var filename = m[1].substr(m[1].lastIndexOf('\\') + 1);
  filename = filename.replace(/%22/g, '"');
  filename = filename.replace(/&#([\d]{4});/g, function(m, code) {
    return String.fromCharCode(code);
  });
  return filename;
};

IncomingForm.prototype._initUrlencoded = function() {
  var self = this;

  parser.onField = function(key, val) {
    self.emit('field', key, val);
  };

  parser.onEnd = function() {
    self.ended = true;
    self._maybeEnd();
  };

};

IncomingForm.prototype._initOctetStream = function() {
  var self = this;
 
  var filename = self.headers['x-file-name'];
  var mime = self.headers['content-type'];

  var file = new File({
    path: self._uploadPath(filename),
    name: filename,
    type: mime,
    hash: self.hash,
  });
  
  file.open();

  self.emit('fileBegin', filename, file);
  
  self._flushing++;
  
  self._parser = new OctetParser();

  //Keep track of writes that haven't finished so we don't emit the file before it's done being written
  var outstandingWrites = 0;

  self._parser.on('data', function(buffer){
    self.pause();
    outstandingWrites++;

    file.write(buffer, function() {
      outstandingWrites--;
      self.resume();

      if(self.ended){
        self._parser.emit('doneWritingFile');
      }
    });
  });

  self._parser.on('end', function(){
    self.ended = true;

    var done = function(){
      self._flushing--;
      self.emit('file', 'file', file);
      self._maybeEnd();
    };

    if(outstandingWrites === 0){
      done();
    } else {
      self._parser.once('doneWritingFile', done);
    }
  });
};

IncomingForm.prototype._uploadPath = function(filename) {
  var name, ext, i;

  name = '';
  for (i = 0; i < 32; i++) {
    name += Math.floor(Math.random() * 16).toString(16);
  }

  name += path.extname(filename);

  return path.join(this.uploadDir, name);
};

IncomingForm.prototype._maybeEnd = function() {
  if (!this.ended || this._flushing) {
    return;
  }

  this.emit('end');
};
