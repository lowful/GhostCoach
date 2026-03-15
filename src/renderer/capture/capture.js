// Hidden renderer process: handles desktopCapturer (unavailable in main process in Electron 14+)
(async function () {
  const { ipcRenderer, desktopCapturer } = require('electron');

  ipcRenderer.on('capture:request', async (_, { width, height }) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      });

      const primarySource =
        sources.find(s => s.id.startsWith('screen:') && (
          s.name === 'Entire Screen' ||
          s.name === 'Screen 1' ||
          s.name.toLowerCase().includes('screen')
        )) || sources[0];

      if (!primarySource) {
        ipcRenderer.send('capture:result', { error: 'No screen source found' });
        return;
      }

      const jpegBuffer = primarySource.thumbnail.toJPEG(85);
      const base64 = jpegBuffer.toString('base64');
      ipcRenderer.send('capture:result', { base64 });

    } catch (err) {
      ipcRenderer.send('capture:result', { error: err.message });
    }
  });
})();
