'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var WebSocketServer = require('ws').Server;
var http = require('http');
var WsSocket = require('./wssocket');

var curId = 0;

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
    opts.heartbeatTimeout = opts.heartbeatTimeout * 1000 || 10000;
    this.opts = opts;
};

util.inherits(Connector, EventEmitter);

module.exports = Connector;

/**
 * Start connector to listen the specified port
 */
Connector.prototype.start = function (cb) {
    var self = this;
    // var server = http.createServer(function (request, res) {
    //     console.log((new Date()) + ' Received request for ' + request.url);
    //     const headers = {
    //         'Access-Control-Allow-Origin': '*',
    //         'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
    //         'Access-Control-Max-Age': 2592000, // 30 days
    //         /** add other headers as per requirement */
    //     };
    //
    //     if (req.method === 'OPTIONS') {
    //         res.writeHead(204, headers);
    //         res.end();
    //         return;
    //     }
    //
    //     if (['GET', 'POST'].indexOf(req.method) > -1) {
    //         res.writeHead(200, headers);
    //         res.end('Hello World');
    //         return;
    //     }
    //
    //     res.writeHead(405, headers);
    //     res.end(`${req.method} is not allowed for the request.`);
    // });
    // server.listen(this.port, function () {
    //     console.log((new Date()) + ' Server is listening on port ' + this.port);
    // });
    this.sockets = [];
    this.wsServer = new WebSocketServer(
        Object.assign({
            port: this.port,
            // perMessageDeflate: {
            //     zlibDeflateOptions: {
            //         // See zlib defaults.
            //         chunkSize: 1024,
            //         memLevel: 7,
            //         level: 3
            //     },
            //     zlibInflateOptions: {
            //         chunkSize: 10 * 1024
            //     },
            //     // Other options settable:
            //     clientNoContextTakeover: true, // Defaults to negotiated value.
            //     serverNoContextTakeover: true, // Defaults to negotiated value.
            //     serverMaxWindowBits: 10, // Defaults to negotiated value.
            //     // Below options specified as default values.
            //     concurrencyLimit: 10, // Limits zlib concurrency for perf.
            //     threshold: 1024 // Size (in bytes) below which messages
            //     // should not be compressed.
            // },
            perMessageDeflate: false,
            verifyClient: originIsAllowed,
        }, this.opts)
    );
    this.wsServer.on("headers", function (headers) {
        headers.push('Access-Control-Allow-Credentials: false');
        headers.push('Access-Control-Allow-Headers: content-type');
        headers.push('Access-Control-Allow-Headers: authorization');
        headers.push('Access-Control-Allow-Headers: x-websocket-extensions');
        headers.push('Access-Control-Allow-Headers: x-websocket-version');
        headers.push('Access-Control-Allow-Headers: x-websocket-protocol');
        headers.push('Access-Control-Allow-Origin: *');
    })
    this.wsServer.on('connection', function (connection, req) {
        var xForwardedAddresses = req.headers['x-forwarded-for'];
        let remoteAddress = {
            ip: xForwardedAddresses ? xForwardedAddresses.split(",")[0] : req.connection.remoteAddress,
            port: req.connection.remotePort
        };
        var wsSocket = new WsSocket(++curId, connection, remoteAddress);
        wsSocket.on('disconnect', function (reason) {
            wsSocket.send({route: 'onKick', reason: reason});
            self.sockets.splice(self.sockets.indexOf(wsSocket), 1);
        });
        self.emit('connection', wsSocket);
        self.sockets.push(wsSocket);
    });
    this.heartbeatInterval = setInterval(function () {
        var nowTime = (new Date()).getTime();
        self.sockets.map(function (wsSocket) {
            if ((nowTime - self.opts.heartbeatTimeout) > wsSocket.lastPingTime) {
                wsSocket.disconnect();
                self.sockets.splice(self.sockets.indexOf(wsSocket), 1);
            } else {
                wsSocket.ping('ping');
            }
        });
    }, this.opts.keepaliveInterval);
    process.nextTick(cb);
};

/**
 * Stop connector
 */
Connector.prototype.stop = function (force, cb) {
    if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
    }
    this.wsServer.close(function () {

    });
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

var originIsAllowed = function (info) {
    if (typeof info === "string" && info.indexOf("youtufun.") === -1) {
        return false;
    }
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