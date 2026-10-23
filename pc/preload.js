'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcs', {
    sources: () => ipcRenderer.invoke('sources'),
    thumbs: (ids) => ipcRenderer.invoke('thumbs', ids),
    net: () => ipcRenderer.invoke('net'),
    start: (opts) => ipcRenderer.invoke('start', opts),
    stop: () => ipcRenderer.invoke('stop'),
    audio: (buf) => ipcRenderer.send('audio', buf),
    on: (channel, fn) => {
        if (['status', 'stats', 'clients', 'thumb'].indexOf(channel) < 0) return;
        ipcRenderer.on(channel, (e, data) => fn(data));
    }
});
