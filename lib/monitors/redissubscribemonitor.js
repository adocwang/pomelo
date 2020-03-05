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
    this.period = opts.period || constants.TIME.DEFAULT_REDIS_REG;//同步周期
    this.expire = opts.expire || (2 * this.period + 1000) / 1000;//过期时间，默认同步周期*2+1000ms
    this.prefix = opts.prefix || "pomelo_monitor:";//redis_key的前缀
    this.password = opts.password || null;
    this.db = opts.db || 0;
    this.redisOpts = opts.redisOpts || {};
    this.redisOpts.retryStrategy = function (times) {
        let delay = Math.min(times * 500, 5000);
        logger.info('redis will reconnect after %s microseconds!', delay);
        return delay;
    };
    this.redisOpts.maxRetriesPerRequest = 10;
    this.redisOpts.autoResubscribe = false;
    this.subscribePattern = '__keyspace@' + this.db + '__:' + this.prefix + "*";
};

module.exports = Monitor;

Monitor.prototype.start = async function (cb) {
    // console.log(this);
    let self = this;
    this.client = new Redis({
        port: this.redisNodes.port,
        host: this.redisNodes.host,
        password: this.redisNodes.password,
        db: this.redisNodes.db,
        options: this.redisOpts
    });
    this.subscriber = new Redis({
        port: this.redisNodes.port,
        host: this.redisNodes.host,
        password: this.redisNodes.password,
        db: this.redisNodes.db,
        options: this.redisOpts
    });

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
        logger.warn("[redisSubscribeMonitor] server has errors with redis server, with error: %j", error);
    });

    this.client.on('close', function () {
        logger.warn("[redisSubscribeMonitor] server has been closed with redis server.");
    });

    this.client.on('end', function () {
        logger.warn("[redisSubscribeMonitor] server is over and without reconnection.");
    });

    this.subscriber.on('error', function (error) {
        logger.warn("[redisSubscribeMonitor] server has errors with redis server, with error: %j", error);
    });

    this.subscriber.on('close', function () {
        logger.warn("[redisSubscribeMonitor] server has been closed with redis server.");
    });

    this.subscriber.on('end', function () {
        logger.warn("[redisSubscribeMonitor] server is over and without reconnection.");
    });
    this.updateInfoTimer = setInterval(this.updateServerInfo.bind(this), this.period);
    await this.updateServerInfo(true);
    await this.syncServers();
    utils.invokeCallback(cb);
};

Monitor.prototype.stop = function (cb) {
    logger.warn('server stopping!');
    if (this.updateInfoTimer !== null) {
        clearInterval(this.updateInfoTimer);
        this.updateInfoTimer = null;
    }
    this.subscriber.punsubscribe(this.subscribePattern, function (err, count) {
    });
    this.subscriber.quit(function () {
    });
    this.client.del(this.prefix + this.app.serverId).then().catch();
    this.client.quit(function () {
    });
    utils.invokeCallback(cb);
};

Monitor.prototype.handleChange = function (pattern, channel, message) {
    let prePos = channel.toString().indexOf('__:' + this.prefix);
    let serverId = channel.toString().substr(prePos + this.prefix.length + 3);
    if (message === "set") {//设置key
        this.handleAdd(serverId);
    } else if (message === "del") {//删除key
        this.handleRemove(serverId);
    } else if (message === "expired") {//key过期
        this.handleExpire(serverId);
    } else if (message === "expire") {//设置EX
    } else {
        logger.debug('unhandled subscribe channel:%s message%s', channel, message);
    }
};

/**
 * 处理，有服务器加入
 * @param serverId
 */
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
    // let selfServer = this.app.getCurServer();
    // if (serverId === selfServer.id) {
    //     await this.updateServerInfo(true);
    //     logger.error('server removed in redis but still alive:%s', serverId);
    //     return;
    // }
    let servers = await this.getServersInRedis();
    if (servers[serverId]) {
        logger.warn('server remove failed serverId is:%s', serverId)
    }
    this.app.replaceServers(servers);
};

/**
 * 添加服务器，现在是直接同步redis
 * @param serverId
 * @return {Promise<void>}
 */
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
        if (!server || !server.id) {
            continue;
        }
        servers[server.id] = server;
    }
    return servers;
};

/**
 * 把redis里面的信息同步到app里
 * @return {Promise<void>}
 */
Monitor.prototype.syncServers = async function () {
    let servers = await this.getServersInRedis();
    this.app.replaceServers(servers);
};

/**
 * 刷新当前server在redis里的信息以及过期时间
 * @param force 强制写进redis
 * @return {Promise<void>}
 */
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