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
    logger
};
