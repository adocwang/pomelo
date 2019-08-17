'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var WebSocketServer = require('websocket').server;
var http = require('http');
var WsSocket = require('./wssocket');

var curId = 1;

/**
 * Connector that manager low level connection and protocol bewteen server and client.
 * Develper can provide their own connector to switch the low level prototol, such as tcp or probuf.
 */
var Connector = function (port, host, opts) {
    if (!(this instanceof Connector)) {
        return new Connector(port, host, opts);
    }

    EventEmitter.call(this);
    this.port = port;
    this.host = host;
    opts.closeTimeout = opts.closeTimeout || 5000;
    opts.keepalive = opts.heartbeatTimeout > 0;
    opts.dropConnectionOnKeepaliveTimeout = opts.keepalive;
    opts.keepaliveInterval = opts.heartbeatInterval * 1000 || 20000;
    opts.keepaliveGracePeriod = opts.heartbeatTimeout * 1000 || 10000;
    this.opts = opts;
};

util.inherits(Connector, EventEmitter);

module.exports = Connector;

/**
 * Start connector to listen the specified port
 */
Connector.prototype.start = function (cb) {
    var self = this;
    var server = http.createServer(function (request, response) {
        console.log((new Date()) + ' Received request for ' + request.url);
        response.writeHead(404);
        response.end();
    });
    server.listen(this.port, function () {
        console.log((new Date()) + ' Server is listening on port ' + this.port);
    });
    this.wsServer = new WebSocketServer(
        Object.assign({
            httpServer: server,
            autoAcceptConnections: false
        }, this.opts)
    );
    this.wsServer.on('request', function (request) {
        if (!originIsAllowed(request.origin)) {
            // Make sure we only accept requests from an allowed origin
            request.reject();
            console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
            return;
        }
    });
    this.wsServer.on('connect', function (connection) {
            console.log((new Date()) + ' Connection accepted.');
            var wsSocket = new WsSocket(curId++, connection, self.opts);
            wsSocket.on('closing', function (reason) {
                wsSocket.send({route: 'onKick', reason: reason});
            });
        }
    );
    process.nextTick(cb);
};

/**
 * Stop connector
 */
Connector.prototype.stop = function (force, cb) {
    this.wsServer.shutDown();
    process.nextTick(cb);
};

Connector.encode = Connector.prototype.encode = function (reqId, route, msg) {
    if (reqId) {
        return composeResponse(reqId, route, msg);
    } else {
        return composePush(route, msg);
    }
};

/**
 * Decode client message package.
 *
 * Package format:
 *   message id: 4bytes big-endian integer
 *   route length: 1byte
 *   route: route length bytes
 *   body: the rest bytes
 *
 * @param  {String} data socket.io package from client
 * @return {Object}      message object
 */
Connector.decode = Connector.prototype.decode = function (msg) {
    var decoded = JSON.parse(msg);
    return {
        id: decoded.id,
        route: decoded.route,
        body: JSON.parse(decoded.data)
    };
};

var originIsAllowed = function (origin) {
    console.log(origin);
    return true;
};

var composeResponse = function (msgId, route, msgBody) {
    return {
        id: msgId,
        body: msgBody
    };
};

var composePush = function (route, msgBody) {
    return JSON.stringify({route: route, body: msgBody});
};

var parseIntField = function (str, offset, len) {
    var res = 0;
    for (var i = 0; i < len; i++) {
        if (i > 0) {
            res <<= 8;
        }
        res |= str.charCodeAt(offset + i) & 0xff;
    }

    return res;
};