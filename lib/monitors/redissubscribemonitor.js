'use strict';
const Redis = require('ioredis');
const logger = require('pomelo-logger').getLogger('pomelo', __filename);
const constants = require('../util/constants');
const utils = require('../util/utils');

const Monitor = function (app, opts) {
    if (!(this instanceof Monitor)) {
        return new Monitor(app, opts);
    }
    this.app = app;
    this.redisNodes = opts.redisNodes || [];
    this.period = opts.period || constants.TIME.DEFAULT_REDIS_REG;
    this.expire = opts.expire || (2 * this.period + 1000) / 1000;
    this.prefix = opts.prefix || "pomelo_monitor:";
    this.password = opts.password || null;
    this.db = opts.db || 0;
    this.redisOpts = opts.redisOpts || {};
    this.subscribePattern = '__keyspace@' + this.db + '__:' + this.prefix + "*";
};

module.exports = Monitor;

Monitor.prototype.start = function (cb) {
    // console.log(this);
    let self = this;
    this.client = new Redis(this.redisNodes.port, this.redisNodes.host, this.redisOpts);
    this.subscriber = new Redis(this.redisNodes.port, this.redisNodes.host, this.redisOpts);

    this.subscriber.on('connect', function () {
        logger.info('%s connected to redis successfully !', self.app.serverId);
        self.subscriber.on("pmessage", self.handleChange.bind(self));
        self.subscriber.psubscribe(self.subscribePattern, function (err, count) {
            if (err) {
                logger.error(err);
            }
        });
    });

    this.client.on('error', function (error) {
        logger.error("[redisMonitor] server has errors with redis server, with error: %j", error);
    });

    this.client.on('close', function () {
        logger.error("[redisMonitor] server has been closed with redis server.");
    });

    this.client.on('end', function () {
        logger.error("[redisMonitor] server is over and without reconnection.");
    });
    this.updateInfoTimer = setInterval(this.updateServerInfo.bind(this), this.period);
    this.updateServerInfo(true);
    this.syncServers();
    utils.invokeCallback(cb);
};

Monitor.prototype.stop = function (cb) {
    this.subscriber.punsubscribe(this.subscribePattern, function (err, count) {
    });
    this.client.del(this.prefix + this.app.serverId).then().catch();
    this.subscriber.quit(function () {
    });
    this.client.quit(function () {
    });
    if (this.updateInfoTimer !== null) {
        clearInterval(this.updateInfoTimer);
        this.updateInfoTimer = null;
    }
    utils.invokeCallback(cb);
};

Monitor.prototype.handleChange = function (pattern, channel, message) {
    let prePos = channel.toString().indexOf('__:' + this.prefix);
    let serverId = channel.toString().substr(prePos + this.prefix.length + 3);
    logger.debug('serverId:' + serverId + ' change:' + message);
    if (message === "set") {
        this.handleAdd(serverId);
    } else if (message === "del") {
        this.handleRemove(serverId);
    } else if (message === "expired") {
        this.handleExpire(serverId);
    } else if (message === "expire") {

    } else {
        logger.debug('unhandled subscribe channel:%s message%s', channel, message);
    }
};

Monitor.prototype.handleAdd = function (serverId) {
    logger.info('server add:%s', serverId);
    this.addServer(serverId).then().catch();
};

Monitor.prototype.handleRemove = function (serverId) {
    logger.info('server remove:%s', serverId);
    this.removeServer(serverId).then().catch();
};

Monitor.prototype.handleExpire = function (serverId) {
    logger.info('server expire:%s', serverId);
    this.removeServer(serverId).then().catch();
};

Monitor.prototype.removeServer = async function (serverId) {
    let selfServer = this.app.getCurServer();
    if (serverId === selfServer.id) {
        setTimeout(this.updateServerInfo.bind(this), 1000);
        logger.error('server removed in redis but still alive:%s', serverId);
        return;
    }
    let servers = await this.getServersInRedis();
    if (servers[serverId]) {
        logger.warn('server remove failed serverId is:%s', serverId)
    }
    this.app.replaceServers(servers);
};

Monitor.prototype.addServer = async function (serverId) {
    let servers = await this.getServersInRedis();
    if (!servers[serverId]) {
        logger.warn('server add failed serverId is:%s', serverId)
    }
    this.app.replaceServers(servers);
};

Monitor.prototype.getServersInRedis = async function () {
    let serverKeys = await this.scan(this.prefix + "*");
    let serverResults = await this.multi_get(serverKeys);
    let servers = {};
    for (let i in serverResults) {
        let server = serverResults[i];
        servers[server.id] = server;
    }
    return servers;
};


Monitor.prototype.syncServers = async function () {
    let servers = await this.getServersInRedis();
    this.app.replaceServers(servers);
};

Monitor.prototype.updateServerInfo = async function (force) {
    let selfServer = this.app.getCurServer();
    selfServer.state = this.app.get(constants.RESERVED.SERVER_STATE);
    let key = this.prefix + selfServer.id;
    let selfInRedis = await this.client.get(key);
    if (!selfInRedis || force) {
        await this.client.set(key, JSON.stringify(selfServer), 'EX', this.expire);
    } else {
        selfInRedis = JSON.parse(selfInRedis);
        if (selfInRedis.state !== selfServer.state) {
            await this.client.set(key, JSON.stringify(selfServer), 'EX', this.expire);
        } else {
            await this.client.expire(key, this.expire);
        }
    }
};


Monitor.prototype.scan = async function (pattern) {
    let that = this;
    try {
        let p = new Promise(function (resolve, reject) {
            try {
                let keys = [];
                let stream = that.client.scanStream({
                    match: pattern,
                });
                stream.on('data', function (resultKeys) {
                    for (let i = 0; i < resultKeys.length; i++) {
                        keys.push(resultKeys[i]);
                    }
                });
                stream.on('end', function () {
                    resolve(keys);
                });
            } catch (e) {
                reject(e);
            }
        });
        return await p;
    } catch (e) {
        logger.error(e);
        return [];
    }
};

Monitor.prototype.multi_get = async function (keys) {
    if (keys.length < 1) {
        logger.warn("keys empty");
        return {};
    }
    let values = await this.client.mget.apply(this.client, keys);
    let maps = {};
    values.map((value, i) => {
        if (typeof value === "string") {
            value = JSON.parse(value);
        } else {
            value = null;
        }
        maps[(keys[i])] = value;
    });
    return maps;
};