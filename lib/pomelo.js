'use strict';
/*!
 * Pomelo
 * Copyright(c) 2012 xiechengchao <xiecc@163.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */
var fs = require('fs');
var path = require('path');
var application = require('./application');
var Package = require('../package');

/**
 * Expose `createApplication()`.
 *
 * @module
 */

var Pomelo = module.exports = {};

/**
 * Framework version.
 */

Pomelo.version = Package.version;

/**
 * Event definitions that would be emitted by app.event
 */
Pomelo.events = require('./util/events');

/**
 * constant definitions that would be emitted by app.event
 */
Pomelo.constants = require('./util/constants');

/**
 * auto loaded components
 */
Pomelo.components = {};

/**
 * auto loaded filters
 */
Pomelo.filters = {};

/**
 * auto loaded rpc filters
 */
Pomelo.rpcFilters = {};

/**
 * connectors
 */
Pomelo.connectors = {};
Pomelo.connectors.__defineGetter__('sioconnector', load.bind(null, './connectors/sioconnector'));
Pomelo.connectors.__defineGetter__('hybridconnector', load.bind(null, './connectors/hybridconnector'));
Pomelo.connectors.__defineGetter__('udpconnector', load.bind(null, './connectors/udpconnector'));
Pomelo.connectors.__defineGetter__('mqttconnector', load.bind(null, './connectors/mqttconnector'));
Pomelo.connectors.__defineGetter__('wsconnector', load.bind(null, './connectors/wsconnector'));

/**
 * pushSchedulers
 */
Pomelo.pushSchedulers = {};
Pomelo.pushSchedulers.__defineGetter__('direct', load.bind(null, './pushSchedulers/direct'));
Pomelo.pushSchedulers.__defineGetter__('buffer', load.bind(null, './pushSchedulers/buffer'));

/**
 * monitors
 */
Pomelo.monitors = {};
Pomelo.monitors.__defineGetter__('zookeepermonitor', load.bind(null, './monitors/zookeepermonitor'));
Pomelo.monitors.__defineGetter__('redismonitor', load.bind(null, './monitors/redismonitor'));
Pomelo.monitors.__defineGetter__('redismonitorlight', load.bind(null, './monitors/redismonitorlight'));
Pomelo.monitors.__defineGetter__('etcdmonitor', load.bind(null, './monitors/etcdmonitor'));
Pomelo.monitors.__defineGetter__('redissubscribemonitor', load.bind(null, './monitors/redissubscribemonitor'));

/**
 * Create an pomelo application.
 *
 * @return {Application}
 * @memberOf Pomelo
 * @api public
 */
Pomelo.createApp = function (opts) {
    var app = application;
    app.init(opts);
    Pomelo.app = app;
    return app;
};

/**
 * Get application
 */
/*Object.defineProperty(Pomelo, 'app', {
  get:function () {
    return abc.app;
  }
});
*/
/**
 * Auto-load bundled components with getters.
 */
fs.readdirSync(__dirname + '/components').forEach(function (filename) {
    if (!/\.js$/.test(filename)) {
        return;
    }
    var name = path.basename(filename, '.js');
    var _load = load.bind(null, './components/', name);

    Pomelo.components.__defineGetter__(name, _load);
    Pomelo.__defineGetter__(name, _load);
});

fs.readdirSync(__dirname + '/filters/handler').forEach(function (filename) {
    if (!/\.js$/.test(filename)) {
        return;
    }
    var name = path.basename(filename, '.js');
    var _load = load.bind(null, './filters/handler/', name);

    Pomelo.filters.__defineGetter__(name, _load);
    Pomelo.__defineGetter__(name, _load);
});

fs.readdirSync(__dirname + '/filters/rpc').forEach(function (filename) {
    if (!/\.js$/.test(filename)) {
        return;
    }
    var name = path.basename(filename, '.js');
    var _load = load.bind(null, './filters/rpc/', name);

    Pomelo.rpcFilters.__defineGetter__(name, _load);
});

function load(path, name) {
    if (name) {
        return require(path + name);
    }
    return require(path);
}
