// places to store the current state of the application
// Now using SQLite for persistence so driver can reconnect and resume
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const AutomatedDriver = require('./automatedDriver.js');
const PlaylistDriver = require('./playlistDriver.js');
const { logger, validSessId, sessionFileBase } = require('./utils.js');

const channels = ['left', 'right', 'pain-left', 'pain-right', 'bottle'];

class ElectronState {
    constructor(config={}) {
        this.config = config;
        
        // Initialize SQLite database
        const dbPath = path.resolve(config.dbPath || './electron-state.sqlite3');
        this.db = new Database(dbPath); // , { verbose: logger });
        this.db.pragma('journal_mode = WAL'); // Better concurrent access
        
        // Create tables if they don't exist
        this.initDatabase();
        
        // In-memory caches for performance (sockets can't be serialized)
        this.driverSockets = {};        // stores sockets for people driving sessions
        this.riders = {};               // stores all sockets for people riding each session
        this.automatedDrivers = {};     // stores automated drivers by their session ids
        this.trafficLights = {};        // dictionary binding sockets to red / yellow / green traffic lights
        this.emojiResponses = {};       // dictionary binding sockets to emoji responses
        this.riderJoinTimes = {};       // dictionary binding sockets to join timestamp (ms)
        this.lastRiderAt = {};          // sessId -> last time (ms) the session had a rider

        logger('[] startup');
        if (this.config.verbose) logger('[] verbose logging enabled');
        if (this.config.memoryMonitor) logger('[] memoryMonitor logging enabled');

        this.logActiveSessionCount();
        this.startRiderReaper();
        this.startIdleSessionReaper();
    }

    initDatabase() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sess_id TEXT PRIMARY KEY,
                driver_token TEXT,
                session_start_time INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_flags (
                sess_id TEXT,
                flag_name TEXT,
                flag_value TEXT,
                PRIMARY KEY (sess_id, flag_name),
                FOREIGN KEY (sess_id) REFERENCES sessions(sess_id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sess_id TEXT,
                channel TEXT,
                stamp INTEGER,
                message TEXT,
                created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
                FOREIGN KEY (sess_id) REFERENCES sessions(sess_id) ON DELETE CASCADE
            )
        `);
        
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_session_channel 
            ON messages(sess_id, channel)
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS message_stamps (
                sess_id TEXT,
                channel TEXT,
                stamp INTEGER,
                PRIMARY KEY (sess_id, channel),
                FOREIGN KEY (sess_id) REFERENCES sessions(sess_id) ON DELETE CASCADE
            )
        `);

        logger('[] Database initialized');
    }

    getCamUrlList() {
        return this.config.camUrlList;
    }

    getVerbose() {
        return this.config.verbose;
    }

    initSessionData(sessId) {
        // Check if session exists
        const existing = this.db.prepare('SELECT sess_id FROM sessions WHERE sess_id = ?').get(sessId);

        if (! existing) {
            // Create new session
            this.db.prepare('INSERT INTO sessions (sess_id, session_start_time) VALUES (?, 0)').run(sessId);
            this.updateMessageStamps(sessId);
            // Start the idle clock now, so a session nobody ever joins is still
            // reaped rather than sitting empty forever.
            this.lastRiderAt[sessId] = Date.now();
        }

        // Set default flags for new driver
        this.setSessionFlag(sessId, 'driverName', 'Anonymous');

        if (this.config.camUrlList && this.config.camUrlList.length > 0) {
            const defaultItem = this.config.camUrlList.filter((item) => item.default)[0];
            if (defaultItem !== undefined) {
                this.setSessionFlag(sessId, 'camUrl', defaultItem.name);
            }
        }
        
        // Remove certain flags
        this.db.prepare('DELETE FROM session_flags WHERE sess_id = ? AND flag_name IN (?, ?)').run(
            sessId, 'filePlaying', 'fileDriver'
        );

        // Only update if we have a real driver, not automated
        if (this.driverSockets[sessId]) {
            const sessionflags = this.getSessionFlags(sessId);
            this.driverSockets[sessId].emit('updateFlags', sessionflags);
            if (this.riders[sessId]) {
                this.riders[sessId].forEach(function(s) {
                    s.emit('updateFlags', sessionflags);
                });
            }
        }

        this.logActiveSessionCount();
        if (this.config.memoryMonitor) logger("[%s] memoryMonitor: initSessionData %o", sessId, process.memoryUsage());
    }

    cleanupSessionData(sessId) {
        if (! sessId) return;
        if (! validSessId(sessId)) {
          logger("[%s] Invalid session id in cleanupSessionData, refusing to cleanup.", sessId);
          return;
        }

        // Save session script file if enabled
        if (this.config.savedSessionsPath && ! this.automatedDrivers[sessId]) {
            try {
                const sessionMessages = this.getSessionMessages(sessId);
                if (sessionMessages !== 'No messages stored') {
                    const savedSessionsDir = path.resolve(this.config.savedSessionsPath);
                    if (! fs.existsSync(savedSessionsDir)) {
                        fs.mkdirSync(savedSessionsDir, { recursive: true });
                    }
                    // Name the file after the driver's name / session info when
                    // they set them, falling back to the session id.
                    const base = sessionFileBase(sessId, this.getSessionFlags(sessId));

                    let filePath;
                    let i = 0;
                    do {
                        const fileName = `${base}${i > 0 ? ` (${i})` : ''}.json`;
                        // basename() is a belt-and-braces guard: sessionFileBase
                        // already strips separators, but this file must never be
                        // able to land outside savedSessionsDir.
                        filePath = path.join(savedSessionsDir, path.basename(fileName));
                        i++;
                    } while (fs.existsSync(filePath));

                    if (! path.resolve(filePath).startsWith(savedSessionsDir + path.sep)) {
                        throw new Error(`refusing to write outside ${savedSessionsDir}`);
                    }

                    fs.writeFileSync(filePath, sessionMessages, 'utf8');
                    logger("[%s] Session saved to %s", sessId, filePath);
                }
            } catch (err) {
                logger("[%s] Error saving session to file: %s", sessId, err.message);
            }

            // expire old saved sessions
            if (this.config.savedSessionsDays && this.config.savedSessionsDays > 0) {
                try {
                    const maxAgeMs = (this.config.savedSessionsDays || 3) * 86400000;
                    const now = Date.now();
                    const files = fs.readdirSync(path.resolve(this.config.savedSessionsPath));
                    for (const file of files) {
                        const filePath = path.join(this.config.savedSessionsPath, file);
                        const stat = fs.statSync(filePath);
                        if (stat.isFile() && now - stat.mtime.getTime() > maxAgeMs) {
                          fs.unlinkSync(filePath);
                          logger("[] Removed expired savedSession file %s", file);
                        }
                    }
                } catch (e) {
                    logger("[] Error deleting expired savedSession files: %s", e);
                }
            }
        }

        // Delete from database (cascades to related tables)
        this.db.prepare('DELETE FROM sessions WHERE sess_id = ?').run(sessId);
        
        // Clean up in-memory data
        delete this.automatedDrivers[sessId];
        delete this.driverSockets[sessId];
        if (this.riders[sessId]) {
            for (const socket of this.riders[sessId]) {
                delete this.trafficLights[socket.id];
                delete this.emojiResponses[socket.id];
            }
        }
        delete this.riders[sessId];
        delete this.lastRiderAt[sessId];

        logger("[%s] End session", sessId);

        logger("[] Stale session cleanup...");
        const sessions = this.db.prepare('SELECT sess_id from sessions').all();
        for (const session of sessions) {
          if (session.sess_id === sessId) continue;
          if (!this.driverSockets[session.sess_id] && !this.automatedDrivers[session.sess_id] && 
                 (!this.riders[session.sess_id] || (Array.isArray(this.riders[session.sess_id]) && !this.riders[session.sess_id].length))) {
              this.cleanupSessionData(session.sess_id);
          }
        }

        this.logActiveSessionCount();
        if (this.config.memoryMonitor) logger("[%s] memoryMonitor: cleanupSessionData %o", sessId, process.memoryUsage());
    }

    logActiveSessionCount() {
        const total_riders = Object.values(this.riders).map((i) => i.length).reduce((i, n) => i + n, 0)
        logger("[] Active sessions: %d, total riders: %d", this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count, total_riders);
    }

    setSessionFlag(sessId, flagname, flagval) {
        this.db.prepare(`
            INSERT OR REPLACE INTO session_flags (sess_id, flag_name, flag_value) 
            VALUES (?, ?, ?)
        `).run(sessId, flagname, JSON.stringify(flagval));
    }

    getSessionFlags(sessId) {
        const flags = this.db.prepare(`
            SELECT flag_name, flag_value 
            FROM session_flags 
            WHERE sess_id = ?
        `).all(sessId);
        
        const result = {};
        for (const flag of flags) {
            try {
                result[flag.flag_name] = JSON.parse(flag.flag_value);
            } catch (_e) {
                result[flag.flag_name] = flag.flag_value;
            }
        }
        return result;
    }

    getPublicSessions() {
        const publicSessions = this.db.prepare(`
            SELECT s.sess_id, sf.flag_value as driver_name
            FROM sessions s
            LEFT JOIN session_flags sf ON s.sess_id = sf.sess_id AND sf.flag_name = 'driverName'
            WHERE EXISTS (
                SELECT 1 FROM session_flags 
                WHERE sess_id = s.sess_id 
                AND flag_name = 'publicSession' 
                AND flag_value = 'true'
            )
        `).all();
        
        return publicSessions.map(session => {
            const sessId = session.sess_id;
            const ridercount = this.riders[sessId]?.length || 0;
            let name = sessId;
            try {
                name = session.driver_name ? JSON.parse(session.driver_name) : sessId;
            } catch (_e) {
                name = session.driver_name || sessId;
            }
            return { sessId: sessId, name: name, riders: ridercount };
        });
    }

    setDriverSocket(sessId, socket) {
        this.driverSockets[sessId] = socket;
    }

    addDriverToken(sessId, token, socket) {
        this.setDriverSocket(sessId, socket);
        this.initSessionData(sessId);

        // Update the token after initSessionData so we don't pre-create the
        // session row and prevent initSessionData from detecting a new session.
        this.db.prepare(`
            UPDATE sessions SET driver_token = ?, updated_at = ? WHERE sess_id = ?
        `).run(token, Date.now(), sessId);
    }

    sessionActive(sessId) {
        const existing = this.db.prepare('SELECT sess_id FROM sessions WHERE sess_id = ?').get(sessId);
        return existing ? true : false;
    }

    driverTokenExists(sessId) {
        if (sessId in this.automatedDrivers) return true;
        
        const result = this.db.prepare('SELECT driver_token FROM sessions WHERE sess_id = ?').get(sessId);
        return result !== undefined && result.driver_token;
    }

    validateDriverToken(sessId, driverToken) {
        const result = this.db.prepare('SELECT sess_id, driver_token FROM sessions WHERE sess_id = ?').get(sessId);
        if (! result) return false;
        return result.driver_token === driverToken;
    }

    addRiderSocket(sessId, socket) {
        if (this.riders[sessId]) {
            // Guard against the same socket being registered twice (e.g. a
            // client re-emitting registerRider on reconnect). A duplicate entry
            // would never be fully removed on disconnect (see onDisconnect) and
            // would leak as a zombie rider, as well as double every broadcast.
            if (this.riders[sessId].includes(socket)) return;
            this.riders[sessId].push(socket);
        } else {
            this.riders[sessId] = [socket];
        }
        this.riderJoinTimes[socket.id] = Date.now();
        this.lastRiderAt[sessId] = Date.now();
        if (this.config.memoryMonitor) logger("[%s] memoryMonitor: addRiderSocket %o", sessId, process.memoryUsage());
    }

    validateRider(sessId, socket) {
        if (this.riders[sessId]) {
            return this.riders[sessId].includes(socket);
        } else {
            return false;
        }
    }

    getRiderSockets(sessId) {
        if (!(sessId in this.riders)) {
            return [];
        }
        return this.riders[sessId];
    }

    getDriverSocket(sessId) {
        return this.driverSockets[sessId];
    }

    storeLastMessage(sessId, channel, message) {
        // Ensure session exists
        const session = this.db.prepare('SELECT session_start_time FROM sessions WHERE sess_id = ?').get(sessId);
        if (! session) return;
        
        const now = Date.now();

        // Update session start time if needed
        if (session.session_start_time === 0) {
            this.db.prepare('UPDATE sessions SET session_start_time = ? WHERE sess_id = ?').run(now, sessId);
        }
        
        const stamp_offset = this.getMessageOffset(sessId, channel);
        
        this.updateMessageStamps(sessId, channel);
        
        // Filter out promode keys if needed
        const m = {...message};
        if (! this.config?.features?.promode) {
            this.config?.promodeKeys?.forEach(function(key) { delete m[key]; });
        }
        
        // Store message
        this.db.prepare(`
            INSERT INTO messages (sess_id, channel, stamp, message) 
            VALUES (?, ?, ?, ?)
        `).run(sessId, channel, stamp_offset, JSON.stringify(m));
        
        if (this.config.memoryMonitor) logger("[%s] memoryMonitor: storeLastMessage %o", sessId, process.memoryUsage());
    }

    clearLastMessages(sessId) {
        const now = Date.now();
        
        // Delete all messages for this session
        this.db.prepare('DELETE FROM messages WHERE sess_id = ?').run(sessId);
        
        // Reset session start time
        this.db.prepare('UPDATE sessions SET session_start_time = ? WHERE sess_id = ?').run(now, sessId);

        this.updateMessageStamps(sessId);
        
        if (this.config.memoryMonitor) logger("[%s] memoryMonitor: clearLastMessages %o", sessId, process.memoryUsage());
    }

    updateMessageStamps(sessId, channel=null) {
        const now = Date.now();
        const updateStamp = this.db.prepare('INSERT OR REPLACE INTO message_stamps (sess_id, channel, stamp) VALUES (?, ?, ?)');

        if (channel !== null) {
            updateStamp.run(sessId, channel, now);
        } else {
            for (const ch of channels) {
                updateStamp.run(sessId, ch, now);
            }
        }
    }

    getMessageOffset(sessId, channel) {
        const now = Date.now();
        const stampRow = this.db.prepare('SELECT stamp FROM message_stamps WHERE sess_id = ? AND channel = ?').get(sessId, channel);
        const previousStamp = stampRow?.stamp || now;
        return now - previousStamp;
    }

    setRiderTrafficLight(sessId, socket, color) {
        const sockets = this.getRiderSockets(sessId);
        const invalidColor = ['R', 'Y', 'G', 'N'].indexOf(color) === -1;
        if (sockets.indexOf(socket) === -1 || invalidColor) {
            return;
        }
        this.trafficLights[socket.id] = color;
    }

    getRiderTrafficLight(socket) {
        // valid values: R (red), Y (yellow), G (green), N (none)
        if (socket.id in this.trafficLights) {
            return this.trafficLights[socket.id];
        }
        return 'N';
    }

    setRiderEmoji(sessId, socket, emoji) {
        const sockets = this.getRiderSockets(sessId);
        if (sockets.indexOf(socket) === -1) return;
        if (emoji && this.isValidEmoji(emoji)) {
            this.emojiResponses[socket.id] = emoji;
        } else {
            delete this.emojiResponses[socket.id];
        }
    }

    isValidEmoji(str) {
        if (typeof str !== 'string' || str.length > 20) return false;
        const emojiRegex = /^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+$/u;
        return emojiRegex.test(str);
    }

    getRiderEmojis(sessId) {
        const riderSockets = this.getRiderSockets(sessId);
        const emojis = [];
        riderSockets.forEach((socket) => {
            if (this.emojiResponses[socket.id]) {
                emojis.push(this.emojiResponses[socket.id]);
            }
        });
        return emojis;
    }

    getLastMessage(sessId, channel) {
        const result = this.db.prepare(`
            SELECT stamp, message 
            FROM messages 
            WHERE sess_id = ? AND channel = ? 
            ORDER BY id DESC 
            LIMIT 1
        `).get(sessId, channel);
        
        if (! result) return null;
        
        return {
            stamp: result.stamp,
            message: JSON.parse(result.message)
        };
    }

    getSessionMessages(sessId) {
        const sessionFlags = this.getSessionFlags(sessId);

        // Get all messages for this session grouped by channel
        const messages = this.db.prepare(`
            SELECT channel, stamp, message
            FROM messages
            WHERE sess_id = ?
            ORDER BY id ASC
        `).all(sessId);

        if (messages.length === 0) {
            return 'No messages stored';
        }

        // Detect if promode was used in any message
        const promodeKeys = this.config?.promodeKeys || ['amType2', 'amDepth2', 'amFreq2', 'tOn', 'tOff', 'tAtt'];
        let usesPromode = false;
        for (const m of messages) {
            const msg = JSON.parse(m.message);
            if ((msg.amType2 !== undefined && msg.amType2 !== 'none') ||
                ((msg.tOn !== undefined && msg.tOn > 0) &&
                 (msg.tOff !== undefined && msg.tOff > 0) &&
                 (msg.tAtt !== undefined && msg.tAtt > 0))) {
                usesPromode = true;
                break;
            }
        }

        const data_to_return = {
            'meta': {
                driverName: sessionFlags['driverName'],
                driverComments: sessionFlags['driverComments'],
                version: 1,
                fileType: 'e l e c t r o n script'
            }
        };

        // Group messages by channel
        for (const channel of channels) {
            const channelMessages = messages
                .filter(m => m.channel === channel)
                .map(m => {
                    const msg = JSON.parse(m.message);
                    delete msg.sessId;
                    delete msg.driverToken;
                    // Filter promode keys if not used
                    if (!usesPromode) {
                        promodeKeys.forEach(key => delete msg[key]);
                    }
                    return { stamp: m.stamp, message: msg };
                });

            if (channelMessages.length > 0) {
                data_to_return[channel] = channelMessages;
            }
        }

        return JSON.stringify(data_to_return);
    }

    getRiderData(sessId) {
        const riderSockets = this.getRiderSockets(sessId);
        const riderData = { 'G': 0, 'Y': 0, 'R': 0, 'N': 0, 'total': 0, 'longestMins': 0 };
        const now = Date.now();

        riderSockets.forEach((s) => {
            const color = this.getRiderTrafficLight(s);
            riderData[color]++;
            riderData.total++;
            if (this.riderJoinTimes[s.id]) {
                const mins = (now - this.riderJoinTimes[s.id]) / 60000;
                if (mins > riderData.longestMins) riderData.longestMins = mins;
            }
        });
        riderData.longestMins = parseFloat(riderData.longestMins.toFixed(1));
        return riderData;
    }

    // Defense-in-depth: periodically reap rider sockets that are no longer
    // connected but were never cleaned up (e.g. a 'disconnect' event that never
    // reached onDisconnect). Without this, such sockets linger as zombie riders.
    startRiderReaper() {
        if (this._riderReaperTimer) return;
        const intervalMs = this.config.riderReaperMs || 60000;
        this._riderReaperTimer = setInterval(() => this.reapDeadRiders(), intervalMs);
        if (this._riderReaperTimer.unref) this._riderReaperTimer.unref();
        logger('[] Rider reaper started (every %dms)', intervalMs);
    }

    reapDeadRiders() {
        try {
            const dead = [];
            for (const sessId in this.riders) {
                for (const socket of this.riders[sessId]) {
                    if (!socket.connected && dead.indexOf(socket) === -1) dead.push(socket);
                }
            }
            for (const socket of dead) {
                logger('[] Reaping dead rider socket %s', socket.id);
                this.onDisconnect(socket);
            }
        } catch (e) {
            logger('[] reapDeadRiders error: %s', e && e.stack ? e.stack : e);
        }
    }

    onDisconnect(socket) {
        let found_rider = false;
        const remote_ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

        const joinTime = this.riderJoinTimes[socket.id];
        const durationMins = joinTime ? ((Date.now() - joinTime) / 60000).toFixed(1) : '?';

        for (const sessId in this.riders) {
            // Remove *every* occurrence of this socket, not just the first. A
            // single indexOf/splice would leave any duplicate entries behind as
            // permanent zombie riders once the underlying connection is gone.
            const before = this.riders[sessId].length;
            this.riders[sessId] = this.riders[sessId].filter(s => s !== socket);
            if (this.riders[sessId].length === before) continue;

            found_rider = true;
            const ridersLeft = this.riders[sessId].length;
            logger('[%s] Rider left from %s after %sm (session riders: %d)', sessId, remote_ip, durationMins, ridersLeft);

            if (ridersLeft == 0 && ! this.driverSockets[sessId] && ! this.automatedDrivers[sessId]) {
                logger('[%s] Last rider left, no driver present, ending session', sessId);
                this.cleanupSessionData(sessId);
            }

            if (this.config.memoryMonitor) logger("[%s] memoryMonitor: onDisconnect-rider-left %o", sessId, process.memoryUsage());
        }

        // Always release per-socket state, even if the socket was never tracked
        // as a rider, so these maps can never outlive the connection.
        delete this.riderJoinTimes[socket.id];
        delete this.trafficLights[socket.id];
        delete this.emojiResponses[socket.id];

        if (! found_rider) {
            for (const sessId in this.driverSockets) {
                if (this.driverSockets[sessId] === socket) {
                    logger('[%s] Driver disconnected from %s (session riders: %d)', sessId, remote_ip, this.riders[sessId]?.length || 0);
                    
                    delete this.driverSockets[sessId];

                    // Give the driver time to reconnect before opening it up
                    setTimeout(() => {
                        if (this.driverSockets[sessId]) return;

                        this.db.prepare('UPDATE sessions SET driver_token = NULL WHERE sess_id = ?').run(sessId);
                        if (this.riders[sessId] && this.riders[sessId].length > 0) {
                            this.riders[sessId].forEach(function(s) {
                                const rider_ip = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
                                logger('[%s] Send driverLost to rider at %s', sessId, rider_ip);
                                s.emit('driverLost');
                            });

                            if (this.config.memoryMonitor) logger("[%s] memoryMonitor: onDisconnect-driver-lost %o", sessId, process.memoryUsage());

                        } else {
                            logger('[%s] Driver left, no riders present, ending session', sessId);
                            this.cleanupSessionData(sessId);
                        }
                    }, 5000);
                }
            }
        }
    }

    startAutomatedDriver(sessId, automatedDriverConfig) {
        if (this.driverTokenExists(sessId)) {
            return false;
        }

        if (! this.automatedDrivers[sessId]) {
            this.automatedDrivers[sessId] = new AutomatedDriver(sessId, automatedDriverConfig);
            this.initSessionData(sessId);
            const driverNames = this.config.automatedSession?.driverNames || ['Autodriver'];
            const driverName = driverNames[Math.floor(Math.random() * driverNames.length)];
            this.setSessionFlag(sessId, 'driverName', driverName);
            this.setSessionFlag(sessId, 'publicSession', automatedDriverConfig['publicSession']);
            this.setSessionFlag(sessId, 'blindfoldRiders', false);
            this.setSessionFlag(sessId, 'proMode', automatedDriverConfig['proMode']);
            this.setSessionFlag(sessId, 'driverComments', automatedDriverConfig['driverComments']);
            this.automatedDrivers[sessId].run(this);
            return true;
        } else {
            return false;
        }
    }

    unregisterAutomatedDriver(sessId) {
        this.cleanupSessionData(sessId);
    }

    startPlaylistDriver(playlistConfig) {
        const sessId = playlistConfig.sessId;
        const dir = playlistConfig.directory;
        if (! fs.lstatSync(dir).isDirectory()) {
            logger('[] Configured playlist directory is not a directory: %s', dir);
            return false;
        }

        this.automatedDrivers[sessId] = new PlaylistDriver(sessId, playlistConfig);
        this.initSessionData(sessId);
        this.setSessionFlag(sessId, 'driverName', playlistConfig.driverName || 'Playlistdriver');
        this.setSessionFlag(sessId, 'publicSession', playlistConfig.public);
        this.setSessionFlag(sessId, 'blindfoldRiders', false);
        this.setSessionFlag(sessId, 'proMode', true);
        this.setSessionFlag(sessId, 'driverComments', playlistConfig.driverComments);
        this.setSessionFlag(sessId, 'camUrl', playlistConfig.camUrl);
        this.automatedDrivers[sessId].run(this);
        return true;
    }
    
    // ====== admin panel support ======

    socketIp(socket) {
        try {
            const fwd = socket?.handshake?.headers?.['x-forwarded-for'];
            // x-forwarded-for is a comma separated chain; the client is first
            if (fwd) return String(fwd).split(',')[0].trim();
            return socket?.handshake?.address || 'unknown';
        } catch (_e) {
            return 'unknown';
        }
    }

    // Everything the admin panel needs, in one pass.  Read-only.
    getAdminSnapshot() {
        const now = Date.now();
        const rows = this.db.prepare(`
            SELECT sess_id, session_start_time, created_at, updated_at,
                   driver_token IS NOT NULL AS has_token
            FROM sessions ORDER BY created_at ASC
        `).all();

        const sessions = rows.map(row => {
            const sessId = row.sess_id;
            const flags = this.getSessionFlags(sessId) || {};
            const driverSocket = this.driverSockets[sessId];
            const driver = this.automatedDrivers[sessId];

            let driverKind = 'none';
            if (driver) driverKind = driver instanceof PlaylistDriver ? 'playlist' : 'automated';
            else if (driverSocket) driverKind = 'human';

            let minutesRemaining = null;
            if (driver && typeof driver.minutesRemaining === 'function') {
                try { minutesRemaining = driver.minutesRemaining(); } catch (_e) { minutesRemaining = null; }
            }

            const riders = (this.riders[sessId] || []).map(s => {
                const joined = this.riderJoinTimes[s.id] || null;
                return {
                    socketId: s.id,
                    ip: this.socketIp(s),
                    joinedAt: joined,
                    durationMs: joined ? now - joined : null,
                    connected: s.connected !== false,
                    trafficLight: this.trafficLights[s.id] || null,
                    emoji: this.emojiResponses[s.id] || null
                };
            });

            return {
                sessId: sessId,
                driverName: flags.driverName || null,
                driverComments: flags.driverComments || null,
                publicSession: flags.publicSession === true || flags.publicSession === 'true',
                blindfoldRiders: flags.blindfoldRiders === true,
                camUrl: flags.camUrl || null,
                driverKind: driverKind,
                driverConnected: !!driverSocket,
                driverIp: driverSocket ? this.socketIp(driverSocket) : null,
                hasDriverToken: !!row.has_token,
                minutesRemaining: minutesRemaining,
                createdAt: row.created_at || null,
                startedAt: row.session_start_time || null,
                ageMs: row.created_at ? now - row.created_at : null,
                riders: riders,
                riderCount: riders.length
            };
        });

        return {
            now: now,
            totals: {
                sessions: sessions.length,
                riders: sessions.reduce((n, s) => n + s.riderCount, 0),
                humanDrivers: sessions.filter(s => s.driverKind === 'human').length,
                automatedDrivers: sessions.filter(s => s.driverKind === 'automated' || s.driverKind === 'playlist').length
            },
            playlistConfigured: this.config.playlistSession !== undefined,
            playlistSessId: this.config.playlistSession?.sessId || null,
            uptimeSec: Math.round(process.uptime()),
            memory: process.memoryUsage().rss,
            sessions: sessions
        };
    }

    // Disconnect one rider socket.  onDisconnect() fires via the socket's own
    // disconnect handler, so session bookkeeping cleans itself up.
    adminKickRider(socketId) {
        for (const sessId in this.riders) {
            for (const s of this.riders[sessId]) {
                if (s.id === socketId) {
                    logger('[%s] ADMIN kicking rider %s at %s', sessId, socketId, this.socketIp(s));
                    try { s.emit('adminKicked'); } catch (_e) { /* socket already gone */ }
                    try { s.disconnect(true); } catch (_e) { /* ditto */ }
                    return { ok: true, sessId: sessId };
                }
            }
        }
        return { ok: false, error: 'rider not found' };
    }

    // Stop an automated/playlist driver without tearing down anything else.
    // Both driver classes now implement stop(), which unregisters the session.
    adminStopDriver(sessId) {
        const driver = this.automatedDrivers[sessId];
        if (!driver) return { ok: false, error: 'no automated driver on that session' };
        logger('[%s] ADMIN stopping automated driver', sessId);
        if (typeof driver.stop === 'function') {
            driver.stop(this);
        } else {
            // Defensive: unknown driver type, at least drop the session
            this.cleanupSessionData(sessId);
        }
        return { ok: true };
    }

    adminEndSession(sessId) {
        return this.terminateSession(
            sessId,
            'This session was ended by an administrator.',
            'ADMIN ending session'
        );
    }

    // End a session outright: stop any driver, boot the riders, clean up.
    // Shared by the admin panel and the idle-session reaper.
    terminateSession(sessId, reason, logLabel) {
        const exists = this.db.prepare('SELECT 1 FROM sessions WHERE sess_id = ?').get(sessId);
        if (!exists) return { ok: false, error: 'no such session' };

        logger('[%s] %s', sessId, logLabel || 'Ending session');

        // Grab the sockets FIRST.  cleanupSessionData() drops its bookkeeping
        // without closing anything, so if we stopped the driver before reading
        // these lists we'd leave the riders connected but untracked - the panel
        // would show an empty session while their browsers played on.
        const riderSockets = (this.riders[sessId] || []).slice();
        const driverSocket = this.driverSockets[sessId];

        const driver = this.automatedDrivers[sessId];
        if (driver && typeof driver.stop === 'function') {
            // stop() unregisters, which runs cleanupSessionData for us
            driver.stop(this);
        }

        const payload = { reason: reason };
        for (const s of riderSockets) {
            try { s.emit('sessionEnded', payload); } catch (_e) { /* socket already gone */ }
            try { s.disconnect(true); } catch (_e) { /* ditto */ }
        }

        if (driverSocket) {
            try { driverSocket.emit('sessionEnded', payload); } catch (_e) { /* socket already gone */ }
            try { driverSocket.disconnect(true); } catch (_e) { /* ditto */ }
        }

        // cleanupSessionData is idempotent enough to call again if the driver
        // already triggered it, and is required when there was no driver.
        if (this.db.prepare('SELECT 1 FROM sessions WHERE sess_id = ?').get(sessId)) {
            this.cleanupSessionData(sessId);
        }
        return { ok: true };
    }

    // ====== idle session reaper ======

    // The configured playlist/jukebox session is meant to sit at zero riders
    // waiting for someone to show up, so it must never be reaped.
    isReapExempt(sessId) {
        if (this.config.playlistSession && this.config.playlistSession.sessId === sessId) return true;
        const extra = this.config.idleSessions && this.config.idleSessions.exempt;
        return Array.isArray(extra) && extra.includes(sessId);
    }

    reapIdleSessions() {
        const cfg = this.config.idleSessions || {};
        const noDriverMinutes = cfg.noDriverMinutes === undefined ? 5 : cfg.noDriverMinutes;
        const driverMinutes = cfg.driverPresentMinutes === undefined ? 20 : cfg.driverPresentMinutes;
        const now = Date.now();

        const rows = this.db.prepare('SELECT sess_id FROM sessions').all();
        for (const row of rows) {
            const sessId = row.sess_id;
            if (this.isReapExempt(sessId)) continue;

            // Someone is listening: keep the session and reset its clock.
            if ((this.riders[sessId] || []).length > 0) {
                this.lastRiderAt[sessId] = now;
                continue;
            }

            // First time we've seen this session empty (e.g. it was restored
            // from the database after a restart): start its clock now.
            if (!this.lastRiderAt[sessId]) {
                this.lastRiderAt[sessId] = now;
                continue;
            }

            // A connected human driver is a person waiting to coordinate, so
            // they get a longer grace period.  An automated driver playing to
            // an empty room is exactly the clutter we're clearing out, so it
            // falls under the short timer along with fully abandoned sessions.
            const humanDriverWaiting = !!this.driverSockets[sessId];
            const limitMinutes = humanDriverWaiting ? driverMinutes : noDriverMinutes;
            if (!limitMinutes || limitMinutes <= 0) continue;   // 0 disables that tier

            const idleMs = now - this.lastRiderAt[sessId];
            if (idleMs < limitMinutes * 60000) continue;

            const idleMinutes = Math.max(1, Math.round(idleMs / 60000));
            const plural = idleMinutes === 1 ? 'minute' : 'minutes';
            this.terminateSession(
                sessId,
                `This session was closed automatically after ${idleMinutes} ${plural} with no riders.`,
                `Idle reaper: no riders for ${idleMinutes}m (limit ${limitMinutes}m, driver ${humanDriverWaiting ? 'present' : 'absent'})`
            );
        }
    }

    startIdleSessionReaper() {
        if (this._idleSessionTimer) return;
        const cfg = this.config.idleSessions || {};
        if (cfg.enabled === false) {
            logger('[] Idle session reaper disabled by config');
            return;
        }
        const intervalMs = cfg.checkIntervalMs || 60000;
        this._idleSessionTimer = setInterval(() => {
            try {
                this.reapIdleSessions();
            } catch (e) {
                logger('[] reapIdleSessions error: %s', e && e.stack ? e.stack : e);
            }
        }, intervalMs);
        if (this._idleSessionTimer.unref) this._idleSessionTimer.unref();
        logger('[] Idle session reaper started (no driver: %sm, driver present: %sm, every %dms)',
            cfg.noDriverMinutes === undefined ? 5 : cfg.noDriverMinutes,
            cfg.driverPresentMinutes === undefined ? 20 : cfg.driverPresentMinutes,
            intervalMs);
    }

    close() {
        // Graceful shutdown
        this.db.close();
        logger("[] Database connection closed");
    }
}

module.exports = ElectronState;
