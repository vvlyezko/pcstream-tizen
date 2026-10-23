'use strict';
// Проверка утечки памяти desktopCapturer.getSources в разных режимах.
// electron test/leak-test.js
const { app, desktopCapturer } = require('electron');

async function mem() {
    const info = await process.getProcessMemoryInfo();
    return Math.round(info.private / 1024) + ' MB';
}

async function run(label, opts, n) {
    const before = await mem();
    for (let i = 0; i < n; i++) await desktopCapturer.getSources(opts);
    console.log(label.padEnd(44), 'до', before, '→ после', n, 'вызовов', await mem());
}

app.whenReady().then(async () => {
    await run('окна без миниатюр (0×0)', { types: ['window'], thumbnailSize: { width: 0, height: 0 } }, 15);
    await run('окна без миниатюр + иконки', { types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: true }, 15);
    await run('только экран, миниатюра 320×180', { types: ['screen'], thumbnailSize: { width: 320, height: 180 } }, 15);
    await run('окна с миниатюрами 320×180', { types: ['window'], thumbnailSize: { width: 320, height: 180 } }, 15);
    console.log('пауза 20 с…');
    await new Promise((r) => setTimeout(r, 20000));
    console.log('после паузы', await mem());
    app.quit();
});
