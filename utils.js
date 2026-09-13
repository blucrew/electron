// generates the random token that only the driver of a session will
// possess and will be used to authenticate their requests

const fs = require('fs');
const util = require('util');

let logFilePath = null;
let logMaxBytes = 5 * 1024 * 1024;  // 5 MB per file
let logKeepFiles = 3;

function initLogger(config) {
    if (config && config.logFile) {
        logFilePath = config.logFile;
        if (config.logMaxBytes) logMaxBytes = config.logMaxBytes;
        if (config.logKeepFiles) logKeepFiles = config.logKeepFiles;
    }
}

function rotateIfNeeded() {
    try {
        const stat = fs.statSync(logFilePath);
        if (stat.size < logMaxBytes) return;
        for (let i = logKeepFiles - 1; i >= 1; i--) {
            const from = `${logFilePath}.${i}`;
            const to = `${logFilePath}.${i + 1}`;
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        fs.renameSync(logFilePath, `${logFilePath}.1`);
    } catch (_e) {
        // file doesn't exist yet, fine
    }
}

function generateToken() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 16; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function generateAutomatedSessId() {
    let text = 'AUTO';
    const possible = '0123456789';
    for (let i = 0; i < 6; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function validSessId(sessId) {
  return sessId.match(/^[a-z0-9_-]{10}$/i);
}

// Windows reserved device names.  A file called e.g. "CON.json" is unusable
// there, so these get a suffix rather than being used verbatim.
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Make an arbitrary string safe to use as a single filename component.
//
// driverName and driverComments are free text typed by whoever is driving, so
// this has to be strict: anything that could escape the directory, break a
// filesystem, or produce a hidden file is stripped.  Returns '' when nothing
// usable survives, so callers can fall back to the session id.
function sanitiseFileName(value, maxLength = 80) {
    if (typeof value !== 'string') return '';
    let out = value
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, '')   // control characters, including NUL
        .replace(/[/\\]/g, ' ')            // path separators
        .replace(/[<>:"|?*]/g, '')         // illegal on Windows
        .replace(/\.{2,}/g, '.')           // no ".." traversal
        .replace(/\s+/g, ' ')              // collapse whitespace
        .trim()
        .replace(/^[.\s]+/, '')            // no leading dot (hidden files)
        .replace(/[.\s]+$/, '');           // Windows drops trailing dot/space

    if (out.length > maxLength) out = out.slice(0, maxLength).trim();
    if (RESERVED_NAMES.test(out)) out = `${out} session`;
    return out;
}

function possessive(name) {
    return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// Build the filename (without extension) for a saved session script.
//
//   name + info  ->  "Sir Thorn's Sunday Drive 202"
//   name only    ->  "Sir Thorn's (rn44us3nj5)"
//   info only    ->  "rn44us3nj5 - Sunday Drive 202"
//   neither      ->  "rn44us3nj5"
//
// driverName defaults to 'Anonymous' on every new session, so that value is
// treated as "not set" rather than used as a real name.
function sessionFileBase(sessId, flags = {}) {
    const rawName = flags.driverName === 'Anonymous' ? '' : flags.driverName;
    const name = sanitiseFileName(rawName, 40);
    const info = sanitiseFileName(flags.driverComments, 80);

    let base;
    if (name && info) {
        base = `${possessive(name)} ${info}`;
    } else if (name) {
        base = `${possessive(name)} (${sessId})`;
    } else if (info) {
        base = `${sessId} - ${info}`;
    } else {
        base = sessId;
    }

    // Re-sanitise the joined string, and fall back to the session id - which
    // validSessId() has already vetted - if nothing usable is left.
    return sanitiseFileName(base, 130) || sessId;
}

function logger(...args) {
    args[0] = '[%s] ' + args[0];
    args.splice(1, 0, (new Date()).toLocaleString());
    console.log(...args);

    if (logFilePath) {
        rotateIfNeeded();
        fs.appendFileSync(logFilePath, util.format(...args) + '\n');
    }
}

module.exports = {
    initLogger,
    generateToken,
    generateAutomatedSessId,
    validSessId,
    sanitiseFileName,
    sessionFileBase,
    logger
};
