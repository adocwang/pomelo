'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var ST_INITED = 0;
var ST_CLOSED = 1;

/**
 * Socket class that wraps socket.io socket to provide unified interface for up level.
 */
var Socket = function (id, socket, remoteAddress) {
    EventEmitter.call(this);
    this.id = id;
    this.socket = socket;
    this.lastActiveTime = Date.now();
    this.remoteAddress = remoteAddress;

    var self = this;

    socket.on('close', function (number, reason) {
        self.state = ST_CLOSED;
        self.emit.call(self, 'disconnect', number, reason);
    });

    socket.on('error', function (error) {
        self.emit.call(self, 'error', error)
    });
    socket.on('pong', function (event) {
        self.lastActiveTime = Date.now();
        if (process.env.WS_DEBUG) {
            console.warn("onPooooong id: " + self.id + " time:" + Date.now());
        }
    });
    socket.on('ping', function (event) {
        self.lastActiveTime = Date.now();
        if (process.env.WS_DEBUG) {
            console.warn("onPiiiiing id: " + self.id + " time:" + Date.now());
        }
    });

    socket.on('message', function (msg) {
        self.lastActiveTime = Date.now();
        self.emit.call(self, 'message', msg);
    });

    this.state = ST_INITED;

    // TODO: any other events?
};

util.inherits(Socket, EventEmitter);

module.exports = Socket;

Socket.prototype.ping = function (data) {
    if (this.state !== ST_INITED || this.socket.readyState !== 1) {
        if (process.env.WS_DEBUG) {
            console.warn("Socket state error when ping is trying.");
        }
        return;
    }
    if (process.env.WS_DEBUG) {
        console.warn("onPiiiiing id: " + this.id + " time:" + Date.now());
    }
    this.socket.ping(data);
};

Socket.prototype.send = function (msg) {
    if (this.state !== ST_INITED || this.socket.readyState !== 1) {
        return;
    }
    if (typeof msg !== 'string') {
        msg = JSON.stringify(msg);
    }
    this.socket.send(msg);
};

Socket.prototype.disconnect = function (number, reason) {
    if (this.state === ST_CLOSED) {
        return;
    }
    this.state = ST_CLOSED;
    this.emit.call(this, 'disconnect', number, reason);
    this.socket.close(number, reason);
};

Socket.prototype.sendBatch = function (msgs) {
    this.send(encodeBatch(msgs));
};

/**
 * Encode batch msg to client
 */
var encodeBatch = function (msgs) {
    var res = '[', msg;
    for (var i = 0, l = msgs.length; i < l; i++) {
        if (i > 0) {
            res += ',';
        }
        msg = msgs[i];
        if (typeof msg === 'string') {
            res += msg;
        } else {
            res += JSON.stringify(msg);
        }
    }
    res += ']';
    return res;
};
