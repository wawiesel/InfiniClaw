document.querySelectorAll('.panel-header-tabs').forEach((header) => {
  const buttons = Array.from(header.querySelectorAll('.tab-button'));
  const panel = header.closest('.panel');
  const label = document.getElementById('right-pane-label');
  const metadataTag = document.getElementById('page-metadata');
  const metadata = metadataTag ? JSON.parse(metadataTag.textContent) : null;
  const panels = panel ? Array.from(panel.querySelectorAll('.tab-panel')) : [];

  function show(target) {
    buttons.forEach((button) => {
      button.classList.toggle('active', button.dataset.target === target);
    });
    panels.forEach((panelElement) => {
      panelElement.classList.toggle('active', panelElement.dataset.panel === target);
    });
    if (!label || !metadata) {
      return;
    }
    label.textContent = target === 'test' ? metadata.testLabel : metadata.commentaryLabel;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => show(button.dataset.target));
  });
});
  