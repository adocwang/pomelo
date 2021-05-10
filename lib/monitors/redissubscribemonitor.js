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
    this.setKey = opts.setKey || "pomelo_server_set";//server_set的key 请务必不是由redis_key的前缀开头
    this.password = opts.password || null;
    this.db = opts.db || 0;
    this.redisOpts = opts.redisOpts || {};
    this.redisOpts.retryStrategy = function (times) {
        let delay = Math.min(times * 500, 5000);
        logger.info('redis will reconnect after %s microseconds!', delay);
        return delay;
    };
    if (process.env.NAMESPACE) {
        this.prefix += process.env.NAMESPACE + ":";
    }
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
        self.subscriber.config("get", "notify-keyspace-events").then(config => {
            if (config[1] !== 'g$xeK') {
                logger.error("redis config notify-keyspace-events is " + config[1] + " not g$xeK");
                self.subscriber.config("set", "notify-keyspace-events", "g$xeK").then(result => {
                    if (!result) {
                        logger.error("set redis notify-keyspace-events to g$xeK failed");
                    }
                }).catch(e => {
                    logger.error(e);
                    logger.error("set redis notify-keyspace-events to g$xeK failed");
                });
            }
            self.psubscribe();
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
    this.updateInfoTimer = setInterval(this.updateServerInfo.bind(this, false), this.period);
    this.updateServerInfo(true);
    await this.syncServers();
    utils.invokeCallback(cb);
};

Monitor.prototype.psubscribe = function () {
    this.subscriber.on("pmessage", this.handleChange.bind(this));
    this.subscriber.psubscribe(this.subscribePattern, function (err, count) {
        if (err) {
            logger.error(err);
        }
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
    this.client.del(this.prefix + this.app.getCurServer().id).then().catch();
    this.client.srem(this.setKey, this.app.getCurServer().id).then().catch();
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
    logger.info('server added', servers)
};

Monitor.prototype.getServersInRedis = async function () {
    let serverIds = await this.client.smembers(this.setKey);
    let keys = [];
    for (let id of serverIds) {
        if (id) {
            keys.push(this.prefix + id);
        }
    }
    let serverResults = await this.client.mget(keys);
    let servers = {};
    let emptyMembers = [];
    for (let i in serverResults) {
        let server = JSON.parse(serverResults[i]);
        if (!server || !server.id) {
            emptyMembers.push(i);
            continue;
        }
        servers[server.id] = server;
    }
    if (emptyMembers.length > 0) {
        for (let i in emptyMembers) {
            await this.client.srem(this.setKey, emptyMembers[i]);
        }
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
Monitor.prototype.updateServerInfo = function (force) {
    let selfServer = this.app.getCurServer();
    selfServer.state = this.app.get(constants.RESERVED.SERVER_STATE);
    let key = this.prefix + selfServer.id;
    if (force) {
        this.setInfo(key, selfServer);
    } else {
        this.client.get(key).then(selfKeyInfo => {
            if (!selfKeyInfo) {
                this.setInfo(key, selfServer);
            } else {
                selfKeyInfo = JSON.parse(selfKeyInfo);
                if (selfKeyInfo.state === selfServer.state) {
                    this.client.expire(key, this.expire).then(res => {
                        if (!res) {
                            logger.error("expire key failed");
                        }
                    }).catch(e => {
                        logger.error(e);
                    });
                } else {
                    this.setInfo(key, selfServer);
                }
            }
        });
    }
};

Monitor.prototype.setInfo = function (key, selfServer) {
    this.client.set(key, JSON.stringify(selfServer), 'EX', this.expire).then(res => {
        if (!res) {
            logger.error("set key failed");
        }
    }).catch(e => {
        logger.error(e);
    });
    this.client.sadd(this.setKey, selfServer.id).then(res => {
    }).catch(e => {
        logger.error(e);
    });
};