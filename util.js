'use strict';

const fs = require('fs');
const path = require('path');
const dfns = require('date-fns');
const config = require('config');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');
const { fetch } = require('undici');
const dns = require('dns').promises;
const shodan = require('shodan-client');
const parseDuration = require('parse-duration');
const { parseDate } = require('chrono-node');
const sqlite3 = require('sqlite3');
const { nanoid } = require('nanoid');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const VERSION = PKGJSON.version;
const NAME = PKGJSON.name;
const ENV = process.env.NODE_ENV || 'dev';
const PREFIX = config.redis.prefixOverride || [NAME, ENV].join('-');
const CTCPVersion = config.irc.ctcpVersionOverride || `${config.irc.ctcpVersionPrefix} v${VERSION} <${config.irc.ctcpVersionUrl}>`;
const SearchFileTypes = Object.freeze({
  sqlite: '.sqlite3'
});

Date.prototype.toDRCString = function () { // eslint-disable-line no-extend-native
  return this.toString().replace(/\sGMT.*/, '');
};

function runningInContainer () { return process.env.DRC_IN_CONTAINER; }

async function isXRunning (xName, context, timeoutMs = 1500) {
  const { registerOneTimeHandler, removeOneTimeHandler } = context;
  const reqId = nanoid();
  const keyPrefix = `is${xName}Running`;
  const retProm = new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    const respName = `isXRunning:${keyPrefix}Response`;
    registerOneTimeHandler(respName, reqId, async (data) => {
      clearTimeout(timeoutHandle);
      removeOneTimeHandler(respName, reqId);
      resolve(data);
    });
  });

  await scopedRedisClient(async (client, prefix) => client.publish(prefix, JSON.stringify({
    type: `isXRunning:${keyPrefix}Request`,
    data: { reqId }
  })));

  return retProm;
}

async function isXRunningRequestListener (xName, messageCallback) {
  const client = new Redis(config.redis.url);
  const reqKey = `isXRunning:is${xName}RunningRequest`;

  await client.subscribe(PREFIX, (err) => {
    if (err) {
      throw err;
    }

    client.on('message', async (_chan, msg) => {
      try {
        const { type, data } = JSON.parse(msg);
        if (type === reqKey) {
          await messageCallback(data);
        }
      } catch (e) {
        console.warn(`isXRunningRequestListener(${xName}) malformed message:`, e, msg);
      }
    });
  });

  return client;
}

class Mapper {
  /* The `path` parameter persists here for legacy reasons but it is no longer
     the primary data source: instead it is used to prime (first run) or
     supplement (later runs) the primary source in Redis. Any entries in the
     `path` file will be added to the Redis store _only if they do not already exist_.
  */
  constructor (path, name) {
    this._path = path;
    this._name = name;
    this._ready = false;
  }

  _keyForNetwork (prefix, network) {
    return [prefix, 'Mapper', this._name, network].join(':');
  }

  async init () {
    if (this._path) {
      if (process.env.NODE_ENV) {
        const pathComps = path.parse(this._path);
        this._path = path.resolve(path.join(pathComps.dir, `${pathComps.name}-${process.env.NODE_ENV}${pathComps.ext}`));
      }

      if (!fs.existsSync(this._path)) {
        throw new Error(`Mapper given bad path: ${this._path}`);
      }

      const pathContents = JSON.parse(fs.readFileSync(this._path));
      await scopedRedisClient(async (client, prefix) => {
        for (const [network, netDict] of Object.entries(pathContents)) {
          for (const [key, val] of Object.entries(netDict)) {
            await client.hsetnx(this._keyForNetwork(prefix, network), key, JSON.stringify(val));
          }
        }
      });
    }

    this._ready = true;
  }

  async _guardAccess (scopedFn) {
    if (!this._ready) {
      throw new Error('Mapper mutate method called before ready!');
    }

    return scopedRedisClient(scopedFn);
  }

  async all () {
    return this._guardAccess(async (client, prefix) => {
      const retDict = {};
      const allNets = (await client.keys(this._keyForNetwork(prefix, '*')))
        .map((s) => s.split(':').slice(-1)[0]);

      for (const net of allNets) {
        retDict[net] = await this.forNetwork(net);
      }

      return retDict;
    });
  }

  async forNetwork (network) {
    return this._guardAccess(async (client, prefix) =>
      Object.entries(await client.hgetall(this._keyForNetwork(prefix, network)))
        .reduce((a, [k, vStr]) => ({ [k]: JSON.parse(vStr), ...a }), {}));
  }

  // does not account for multiple 'key's across networks! take care when using accordingly
  async findNetworkForKey (key) {
    return Object.entries((await this.all())).reduce((a, [network, netMap]) =>
      (Object.entries(netMap).find(([k]) => k === key) ? network : a), null);
  }

  async get (network, key) {
    return JSON.parse(await this._guardAccess(async (client, prefix) =>
      client.hget(this._keyForNetwork(prefix, network), key)));
  }

  async set (network, key, value) {
    return this._guardAccess(async (client, prefix) =>
      client.hset(this._keyForNetwork(prefix, network), key, JSON.stringify(value)));
  }

  async remove (network, key) {
    return this._guardAccess(async (client, prefix) =>
      client.hdel(this._keyForNetwork(prefix, network), key));
  }
}

const ChannelXforms = new Mapper(config.irc.channelXformsPath, 'ChannelXforms');
const PrivmsgMappings = new Mapper(null, 'PrivmsgMappings');

ChannelXforms.init();
PrivmsgMappings.init();

function _resolveNameForIRC (xforms, name) {
  return (xforms && xforms[name]) || name;
}

async function resolveNameForIRC (network, name) {
  return _resolveNameForIRC(await ChannelXforms.forNetwork(network), name);
}

function resolveNameForIRCSyncFromCache (allCache, network, name) {
  return _resolveNameForIRC(allCache[network], name);
}

async function resolveNameForDiscord (network, ircName) {
  const resolverRev = Object.entries(await ChannelXforms.all()).reduce((a, [network, nEnt]) => {
    return { [network]: Object.entries(nEnt).reduce((b, [k, v]) => ({ [v]: k, ...b }), {}), ...a };
  }, {});

  return ((network && ircName && (resolverRev && resolverRev[network] &&
    resolverRev[network][ircName.toLowerCase().slice(1)])) || ircName.replace(/^#/, '')).toLowerCase();
}

async function channelsCountProcessed (channels, prev, durationInS) {
  const a = {};
  for (const [ch, count] of Object.entries(channels)) {
    const [_, net, chan] = ch.split(':'); // eslint-disable-line no-unused-vars
    if (!a[net]) {
      a[net] = [];
    }

    let suffix = '';
    let suffixFields = {};
    if (prev && prev[ch]) {
      const delta = count - prev[ch];
      const mpm = Number((delta / durationInS) * 60);
      suffix += delta ? ` (+${delta}${durationInS ? `, ${mpm.toFixed(1)}mpm` : ''})` : ' (_nil_)';
      suffixFields = { delta, mpm };
    }

    const discordName = await resolveNameForDiscord(net, '#' + chan);
    a[net].push({
      count,
      network: net,
      channel: {
        ircName: chan,
        discordName
      },
      msg: `\t**${count}** in **#${discordName}**${suffix}`,
      ...suffixFields
    });
  }

  return a;
}

async function channelsCountToStr (channels, prev, durationInS, sortByMpm) {
  const mapped = await channelsCountProcessed(channels, prev, durationInS);

  let sorter = (a, b) => b.count - a.count;

  if (sortByMpm) {
    sorter = (a, b) => b.mpm - a.mpm;
  }

  const chanStrsMapped = (chanStrs) => chanStrs
    .sort(sorter)
    .slice(0, config.app.statsTopChannelCount)
    .map(x => x.msg)
    .join('\n');

  return Object.entries(mapped).reduce((a, [net, chanStrs]) => (
    a + `**Network**: \`${net}\`\n_\t(Top ${config.app.statsTopChannelCount} ` +
    `of ${chanStrs.length}${sortByMpm ? ', sorted by mpm' : ''})_\n${chanStrsMapped(chanStrs)}\n`
  ), '');
}

async function floodProtect (ops, ...args) {
  for (const op of ops) {
    await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve(await op(...args));
        } catch (e) {
          reject(e);
        }
      }, config.irc.floodProtectWaitMs);
    });
  }
}

function fmtDuration (start, allowSeconds, end = new Date()) {
  if (typeof start === 'string') {
    start = dfns.parseISO(start);
  }

  const defOpts = ['years', 'months', 'weeks', 'days', 'hours', 'minutes'];

  if (allowSeconds) {
    defOpts.push('seconds');
  }

  const options = { format: defOpts };
  const fmt = () => dfns.formatDuration(dfns.intervalToDuration({ start, end }), options);
  let dur = fmt();

  if (!dur) {
    options.format.push('seconds');
    dur = fmt();
  }

  if (dur.match(/days/)) {
    options.format.pop();
    dur = fmt();
  }

  return dur;
}

async function shodanApiInfo () {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY;

  if (!apiKey) {
    return;
  }

  return shodan.apiInfo(apiKey);
}

async function shodanHostLookup (host) {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY;

  if (!apiKey) {
    return;
  }

  try {
    return await shodan.host(host, apiKey);
  } catch (e) {
    if (e.message.indexOf('Invalid IP') !== -1) {
      const resolved = await shodan.dnsResolve(host, apiKey);

      if (resolved[host]) {
        return shodanHostLookup(resolved[host]);
      } else {
        e = new Error(`unable to resolve ${host}`); // eslint-disable-line no-ex-assign
      }
    }

    return {
      error: {
        message: e.message,
        stack: e.stack
      }
    };
  }
}

// for the record i'm annoyed that using exceptions for control flow here
// is easier so i'm doing it, but it is so ia m

class AmbiguousMatchResultError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

class NetworkNotMatchedError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

class UserCommandNotFound extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

function matchNetwork (network, options = { returnScores: false }) {
  const ret = {};

  if (!config.irc.registered[network]) {
    const scored = Object.keys(config.irc.registered)
      .map(rn => [rn.indexOf(network), rn])
      .filter(x => x[0] !== -1)
      .sort((a, b) => a[0] - b[0]);

    if (scored.length && scored[0].length) {
      if (scored.length > 1 && scored[0][0] === scored[1][0]) {
        throw new AmbiguousMatchResultError(network, ' -- Scores: ' + JSON.stringify(scored));
      }

      network = scored[0][1];

      if (options.returnScores) {
        ret.scores = scored;
      }
    } else {
      throw new NetworkNotMatchedError(network);
    }
  }

  return { network, ...ret };
}

function parseRedisInfoSection (section) {
  const lines = section.split(/\r?\n/g);

  if (!lines[0][0] === '#') {
    throw new Error('malformed section', lines);
  }

  const sectionName = lines[0].split(/\s+/)[1];
  lines.shift();
  lines.pop();

  return {
    sectionName,
    kvPairs: lines.reduce((a, line) => ({
      [line.split(':')[0]]: line.split(':')[1],
      ...a
    }), {})
  };
}

async function sizeAtPath (searchPath) {
  let a = 0;
  const curPathEles = await fs.promises.readdir(path.resolve(searchPath));

  for (const curPathEle of curPathEles) {
    const curPath = path.join(searchPath, curPathEle);
    const curStat = await fs.promises.stat(curPath);

    if (curStat.isDirectory()) {
      a += await sizeAtPath(curPath);
    } else if (curStat.isFile()) {
      a += curStat.size;
    }
  }

  return a;
}

function isIpAddress (ip) {
  return ip?.match(/^(?:\d{1,3}\.){3}\d{1,3}$/) !== null;
}

async function ipInfo (ipOrHost) {
  if (!config.ipinfo.token) {
    return null;
  }

  let ip = ipOrHost;
  if (!isIpAddress(ip)) {
    try {
      ip = (await dns.lookup(ipOrHost)).address;
    } catch (err) {
      console.warn(`Lookup for "${ip} failed: ${err.message}`);
      return null;
    }
  }

  const res = await fetch(`https://ipinfo.io/${ip}`, {
    headers: {
      Authorization: `Bearer ${config.ipinfo.token}`
    }
  });

  if (!res.ok) {
    console.warn(`ipinfo.io lookup for "${ip}" failed (${res.status})`, res);
    return null;
  }

  return res.json();
}

const getLogsFormats = {
  json: (x) => x,
  txt: (x) => `[${new Date(x.__drcIrcRxTs).toISOString()}] <${x.nick}> ${x.message}`
};

function tryToParseADateOrDuration (maybeADuration) {
  const chkDate = new Date(maybeADuration);

  if (chkDate.toString() === 'Invalid Date') {
    let parsed = parseDate(maybeADuration);

    if (parsed) {
      return Number(parsed);
    }

    parsed = parseDuration(maybeADuration);

    if (parsed) {
      return Number(new Date()) + parsed;
    }

    return undefined;
  }

  return chkDate;
}

function getLogsSetup (network, channel, { from, to, format = 'json', filterByNick } = {}) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  if (filterByNick && typeof filterByNick === 'string') {
    filterByNick = filterByNick.split(',');
  }

  const formatter = getLogsFormats[format];

  if (!formatter) {
    throw new Error(`bad format ${format}`);
  }

  const [fromTime, toTime] = [from, to].map(tryToParseADateOrDuration);
  const expectedPath = path.resolve(path.join(logCfg.path, network, channel));
  return {
    formatter,
    fromTime,
    toTime,
    expectedPath,
    filterByNick
  };
}

function _queryBuilder (options, fromTime, toTime) {
  const params = [];
  const logicOp = (options.or || options.ored) ? 'OR' : 'AND';
  const columns = options.columns || '*';
  const distinct = options.distinct ? 'DISTINCT ' : '';
  const stringComp = options.strictStrings === true ? '=' : 'LIKE';
  let selectClause = `${distinct}${columns}`;

  if (options.max) {
    selectClause = `MAX(${options.max})`;
  }

  if (options.min) {
    selectClause = `MIN(${options.min})`;
  }

  let query = [
    [options.message, `message ${stringComp}`],
    [options.nick, `nick ${stringComp}`],
    [options.channel, `target ${stringComp}`],
    [options.target, `target ${stringComp}`],
    [options.host, `hostname ${stringComp}`],
    [options.hostname, `hostname ${stringComp}`],
    [options.ident, `ident ${stringComp}`],
    [options.type, 'type ='],
    [fromTime, '__drcIrcRxTs >='],
    [toTime, '__drcIrcRxTs <=']
  ].reduce((q, [val, clause]) => {
    if (val) {
      params.push(val);
      return `${q}${params.length - 1 ? ` ${logicOp}` : ' WHERE'} ${clause} ?`;
    }

    return q;
  }, `SELECT ${selectClause} FROM channel`);

  if (options.from_server) {
    query += `${params.length ? ` ${logicOp}` : ' WHERE'} from_server = 1`;
  }

  return [query, params];
}

async function _userXSeen (network, options, isLast) {
  const opWord = isLast ? 'MAX' : 'MIN';
  const opCol = isLast ? options.max : options.min;
  const sorter = isLast ? (a, b) => b[1] - a[1] : (a, b) => a[1] - b[1];
  const op = `${opWord}(${opCol})`;

  const { totalLines, searchResults } = await searchLogs(network, options, async (network, channel, options) => {
    options.or = true;
    options.max = '__drcIrcRxTs';
    const { expectedPath } = getLogsSetup(network, channel, options);
    const [query, params] = _queryBuilder(options);
    const db = new sqlite3.Database(expectedPath);
    return new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) {
          console.error(`This query failed: ${query}`);
          return reject(err);
        }

        resolve([channel.replace(SearchFileTypes.sqlite, ''), rows]);
      });
    });
  });

  if (totalLines > 0) {
    return Object.entries(searchResults)
      .filter(([, [{ [op]: max }]]) => Boolean(max))
      .map(([channel, [{ [op]: max }]]) => ([channel, max]))
      .sort(sorter)
      .map(([channel, max]) => ([channel, new Date(max).toDRCString()]));
  }

  return [];
}

async function userLastSeen (network, options) {
  return _userXSeen(network, Object.assign({
    or: true,
    max: '__drcIrcRxTs'
  }, options), true);
}

async function userFirstSeen (network, options) {
  return _userXSeen(network, Object.assign({
    or: true,
    min: '__drcIrcRxTs'
  }, options), false);
}

async function getLogsSqlite (network, channel, options) {
  let {
    fromTime,
    toTime,
    expectedPath
  } = getLogsSetup(network, channel, options);

  if (path.parse(expectedPath).ext === '') {
    expectedPath += SearchFileTypes.sqlite;
  }

  const [query, params] = _queryBuilder(options, fromTime, toTime);
  const db = new sqlite3.Database(expectedPath);
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error(`This query failed: ${query}`);
        return reject(err);
      }

      resolve([channel.replace(SearchFileTypes.sqlite, ''), rows]);
    });
  });
}

const checkValAgainst_regexCache = {}; // eslint-disable-line camelcase

function checkValAgainst (opt, field) {
  if (opt.indexOf('/') === 0) {
    const closingIdx = opt.slice(1).indexOf('/') + 1;

    if (closingIdx < 1) {
      throw new Error(`bad regex spec "${opt}"`);
    }

    if (!checkValAgainst_regexCache[opt]) {
      const flags = opt.slice(closingIdx + 1);
      const reExtract = opt.slice(1, -(opt.length - closingIdx));
      checkValAgainst_regexCache[opt] = new RegExp(reExtract, flags);
      console.log('CACHED RE for key', opt, checkValAgainst_regexCache[opt]);
    }

    return field.match(checkValAgainst_regexCache[opt]) !== null;
  }

  return field.indexOf(opt) !== -1;
}

function findFixedNonZero (num, depth = 1, maxDepth = 10) {
  if (depth === maxDepth) {
    return Number(num).toFixed(depth);
  }

  const chk = Number(num).toFixed(depth);
  return Number(chk) ? chk : findFixedNonZero(num, depth + 1);
}

async function searchLogsSqlite (network, networkFiles, options, singleProcFunc) {
  const searchResults = (await Promise.all(networkFiles.map((file) =>
    singleProcFunc(network, file.name, options)
      .catch((e) => {
        console.error(`Searching ${file.name} failed: `, e);
        return [file, []];
      }))))
    .reduce((a, [chan, rows]) => {
      if (!rows.length) {
        return a;
      }

      return { [chan]: rows, ...a };
    }, {}); // whyTF did I chose a map for this? a list of tuples was BETTER!

  return {
    totalLines: Object.values(searchResults).reduce((a, x) => a + x.length, 0),
    searchResults
  };
}

async function searchLogs (network, options, singleProcFunc = getLogsSqlite) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  const expectedPath = path.resolve(path.join(logCfg.path, network));
  const searchExt = SearchFileTypes?.[options.filetype] ?? '.sqlite3';
  let networkFiles = (await fs.promises.readdir(expectedPath, { withFileTypes: true }))
    .filter((fEnt) => fEnt.isFile() && fEnt.name.endsWith(searchExt));

  if (!options.everything) {
    networkFiles = networkFiles.filter((fEnt) => fEnt.name.indexOf('#') === 0);
  }

  let retObj;
  const start = new Date();
  try {
    console.debug('SEARCH LIST:', networkFiles.map(x => x.name).join(', '));
    retObj = await searchLogsSqlite(network, networkFiles, options, singleProcFunc);
  } catch (err) {
    console.error(`searchLogsSqlite(${network}) failed:`, err);
    retObj = { totalLines: 0, searchResults: [], error: err };
  }

  const end = new Date();
  const queryTimeMs = end - start;
  return {
    queryTimeMs,
    queryTimeHuman: fmtDuration(start, true, end),
    ...retObj
  };
}

// ref: https://modern.ircdocs.horse/formatting.html#characters
const ircEscapeXforms = Object.freeze({
  '\x02': '**',
  '\x1d': '_',
  '\x1f': '__',
  '\x1e': '~',
  '\x11': '`'
});

const IRCColorsStripMax = 16;

// the following aren't supported by us, so we just strip them
const ircEscapeStripSet = Object.freeze([
  ...Buffer.from(Array.from({ length: IRCColorsStripMax }).map((_, i) => i)).toString().split('').map(x => `\x03${x}`), // colors
  ...Array.from({ length: 10 }).map((_, i) => i).map(x => `\x030${x}`),
  ...Array.from({ length: 7 }).map((_, i) => i).map(x => `\x03${x + 10}`),
  '\x16', // reverse color
  '\x0f' // reset; TODO, some bots have been seen to use this byte to reset standard escapes (defined in ircEscapeXforms above)... need to handle this
  /*
  2022-01-07T09:42:51.833Z <drc/0.2/discord/debug> replaceIrcEscapes S> "Title: Python Sudoku Solver - Computerphile "
  00000000: 0254 6974 6c65 0f3a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   .Title.: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  2022-01-07T09:42:51.834Z <drc/0.2/discord/debug> replaceIrcEscapes E> "**Title: Python Sudoku Solver - Computerphile "
  00000000: 2a2a 5469 746c 653a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   **Title: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  */
]);

const ircEscapeStripTester = new RegExp(`(${ircEscapeStripSet.join('|')})`);
const ircEscapeTester = new RegExp(`(${Object.keys(ircEscapeXforms).join('|')})`);

function replaceIrcEscapes (message, stripAll = false) {
  let hit = false;
  const orig = message;

  console.debug(`replaceIrcEscapes> ${typeof message} message=${message}`);
  if (message.match(ircEscapeStripTester)) {
    hit = true;
    message = ircEscapeStripSet.reduce((m, esc) => m.replaceAll(esc, ''), message);
    // *after* stripping multi-byte combinations, strip any remaining color start codes (0x03)
    message = message.replaceAll(/\x03/g, ''); // eslint-disable-line no-control-regex
  }

  if (message.match(ircEscapeTester)) {
    let xForms = ircEscapeXforms;
    hit = true;

    if (stripAll) {
      xForms = Object.entries(ircEscapeXforms).reduce((a, [k]) => ({ [k]: '', ...a }), {});
    }

    message = Object.entries(xForms).reduce((m, [esc, repl]) => m.replaceAll(esc, repl), message);
  }

  if (hit) {
    console.debug(`replaceIrcEscapes S> "${orig}"\n` + xxd(orig));
    console.debug(`replaceIrcEscapes E> "${message}"\n` + xxd(message));
  }

  return message;
}

const xxdSplitter = /([a-f0-9]{4})/;
const unprintables = /[^ -~]+/g;

function xxd (buffer, { rowWidth = 32, returnRawLines = false } = {}) {
  if (!(buffer instanceof Buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch (err) {
      console.debug('xxd error', err);
      return;
    }
  }

  const retLines = [];
  for (let startOff = 0; startOff < buffer.length; startOff += rowWidth) {
    const curChunk = buffer.subarray(startOff, startOff + rowWidth);
    retLines.push(
      startOff.toString(16).padStart(8, '0') + ': ' +
      curChunk.toString('hex').split(xxdSplitter).filter(x => x.length).join(' ').padEnd(rowWidth * 2 + ((rowWidth / 2) + 1)) + ' ' +
      curChunk.toString().replace(unprintables, '.')
    );
  }

  return returnRawLines ? retLines : retLines.join('\n');
}

function expiryDurationFromOptions (options) {
  if (options?.ttl === -1) {
    return null;
  }
  return (options.ttl ? options.ttl * 60 : config.http.ttlSecs) * 1000;
}

function expiryFromOptions (options) {
  if (options?.ttl === -1) {
    return null;
  }
  return Number(new Date()) + expiryDurationFromOptions(options);
}

async function scopedRedisClient (scopeCb) {
  const scopeClient = new Redis(config.redis.url);

  try {
    return await scopeCb(scopeClient, PREFIX);
  } catch (e) {
    console.error(e);
  } finally {
    scopeClient.disconnect();
  }

  return null;
}

function isObjPathExtant (obj, path) {
  if (typeof path === 'string') {
    if (path.search('.') === -1) {
      throw new Error(`isObjPathExtant: malformed path "${path}"`);
    }

    path = path.split('.');
  }

  if (obj[path[0]]) {
    const pathMut = Array.from(path);
    return isObjPathExtant(obj[pathMut.shift()], pathMut);
  }

  return !path.length ? obj : null;
}

function fqUrlFromPath (path) {
  return `${config.http.proto}://${config.http.fqdn}/${path}`;
}

module.exports = {
  ircEscapeStripSet,
  ENV,
  NAME,
  PREFIX,
  VERSION,
  CTCPVersion,
  IRCColorsStripMax,

  Mapper,
  ChannelXforms,
  PrivmsgMappings,

  resolveNameForIRC,
  resolveNameForIRCSyncFromCache,
  resolveNameForDiscord,

  channelsCountProcessed,
  channelsCountToStr,
  floodProtect,
  fmtDuration,
  shodanHostLookup,
  shodanApiInfo,
  matchNetwork,
  parseRedisInfoSection,
  sizeAtPath,
  isIpAddress,
  ipInfo,
  getLogsSetup,
  getLogsSqlite,
  searchLogs,
  userLastSeen,
  userFirstSeen,
  checkValAgainst,
  findFixedNonZero,
  replaceIrcEscapes,
  xxd,
  expiryFromOptions,
  expiryDurationFromOptions,
  scopedRedisClient,
  isObjPathExtant,
  isXRunning,
  isXRunningRequestListener,
  fqUrlFromPath,
  runningInContainer,
  tryToParseADateOrDuration,

  AmbiguousMatchResultError,
  NetworkNotMatchedError,
  UserCommandNotFound
};
